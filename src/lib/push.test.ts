import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// web-push'un gerçek ağ çağrısı yerine sahte; `WebPushError` gerçek sınıf
// (push.ts `instanceof` ile ayırıyor).
const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock("web-push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("web-push")>();
  return {
    ...actual,
    default: { ...actual, sendNotification },
    sendNotification,
  };
});

import { WebPushError } from "web-push";
import { db } from "@/lib/db";
import {
  CAPTION_READY_THROTTLE_MS,
  PUSH_MAX_FAILURES,
  getVapidPublicKey,
  notifyCaptionsReady,
  notifyClientUsers,
  resetPushForTests,
  safePushUrl,
} from "@/lib/push";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, createPortalPost } from "@tests/helpers/portal";

const VAPID = {
  VAPID_PUBLIC_KEY: "test-public-key",
  VAPID_PRIVATE_KEY: "test-private-key",
  VAPID_SUBJECT: "mailto:test@ornek.com",
};

function setVapid(on: boolean) {
  for (const [key, value] of Object.entries(VAPID)) {
    if (on) process.env[key] = value;
    else delete process.env[key];
  }
}

let seq = 0;
function subscribe(clientUserId: string, overrides: { failCount?: number } = {}) {
  seq += 1;
  return db.pushSubscription.create({
    data: {
      clientUserId,
      endpoint: `https://web.push.apple.com/cihaz-${seq}`,
      p256dh: "p".repeat(87),
      auth: "a".repeat(22),
      failCount: overrides.failCount ?? 0,
    },
  });
}

const payload = { title: "Videon yayınlandı", body: "İlk satır", url: "/portal/gecmis", tag: "t" };

let agencyId: string;
let clientId: string;

beforeEach(async () => {
  await resetDb();
  resetPushForTests();
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  setVapid(true);
  const agency = await createAgency();
  agencyId = agency.id;
  const client = await createClient(agency.id);
  clientId = client.id;
});

afterEach(() => {
  setVapid(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("notifyClientUsers", () => {
  it("env yokken gönderim denenmez, throw etmez, bir kez uyarır", async () => {
    setVapid(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = await createClientUser(clientId);
    await subscribe(user.id);

    expect(await notifyClientUsers(clientId, payload)).toMatchObject({ sent: 0, skipped: "not_configured" });
    await notifyClientUsers(clientId, payload);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getVapidPublicKey()).toBeNull();
  });

  it("müşterinin TÜM kullanıcılarının TÜM cihazlarına gider; başka müşteriye gitmez", async () => {
    const userA = await createClientUser(clientId);
    const userB = await createClientUser(clientId);
    const other = await createClient(agencyId);
    const otherUser = await createClientUser(other.id);
    const a1 = await subscribe(userA.id);
    const a2 = await subscribe(userA.id);
    const b1 = await subscribe(userB.id, { failCount: 3 });
    const foreign = await subscribe(otherUser.id);

    const result = await notifyClientUsers(clientId, payload);
    expect(result).toMatchObject({ sent: 3, removed: 0, failed: 0 });

    const endpoints = sendNotification.mock.calls.map(([sub]) => sub.endpoint).sort();
    expect(endpoints).toEqual([a1.endpoint, a2.endpoint, b1.endpoint].sort());
    expect(endpoints).not.toContain(foreign.endpoint);

    // Başarı: lastSuccessAt yazılır, art arda hata sayacı sıfırlanır.
    const row = await db.pushSubscription.findUniqueOrThrow({ where: { id: b1.id } });
    expect(row.lastSuccessAt).not.toBeNull();
    expect(row.failCount).toBe(0);
  });

  it("payload: müşteriye özel ikon, kırpılmış metin; seçenekler aes128gcm + VAPID", async () => {
    await db.client.update({ where: { id: clientId }, data: { appIconBase: "/icons/furkan-teacher" } });
    const user = await createClientUser(clientId);
    await subscribe(user.id);

    await notifyClientUsers(clientId, { ...payload, body: "x".repeat(500) });
    const [sub, body, options] = sendNotification.mock.calls[0];
    expect(sub.keys).toEqual({ p256dh: "p".repeat(87), auth: "a".repeat(22) });
    const data = JSON.parse(body);
    expect(data).toMatchObject({
      title: "Videon yayınlandı",
      url: "/portal/gecmis",
      tag: "t",
      icon: "/icons/furkan-teacher/icon-192.png",
    });
    expect(data.body.length).toBeLessThanOrEqual(200);
    expect(options).toMatchObject({
      contentEncoding: "aes128gcm",
      topic: "t",
      vapidDetails: {
        publicKey: VAPID.VAPID_PUBLIC_KEY,
        privateKey: VAPID.VAPID_PRIVATE_KEY,
        subject: VAPID.VAPID_SUBJECT,
      },
    });
  });

  it("güvensiz URL payload'a yazılmaz, portala düşer", async () => {
    const user = await createClientUser(clientId);
    await subscribe(user.id);
    await notifyClientUsers(clientId, { ...payload, url: "https://evil.example/x" });
    expect(JSON.parse(sendNotification.mock.calls[0][1]).url).toBe("/portal");
  });

  it.each([404, 410])("%i → abonelik silinir", async (status) => {
    const user = await createClientUser(clientId);
    const dead = await subscribe(user.id);
    const alive = await subscribe(user.id);
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === dead.endpoint) {
        throw new WebPushError("gitti", status, {}, "", sub.endpoint);
      }
      return { statusCode: 201, body: "", headers: {} };
    });

    expect(await notifyClientUsers(clientId, payload)).toMatchObject({ sent: 1, removed: 1 });
    expect(await db.pushSubscription.findUnique({ where: { id: dead.id } })).toBeNull();
    expect(await db.pushSubscription.findUnique({ where: { id: alive.id } })).not.toBeNull();
  });

  it(`diğer hatalarda failCount artar, ${PUSH_MAX_FAILURES}. hatada silinir; endpoint loga yazılmaz`, async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await createClientUser(clientId);
    const sub = await subscribe(user.id, { failCount: PUSH_MAX_FAILURES - 2 });
    sendNotification.mockRejectedValue(
      new WebPushError("sunucu hatası", 500, {}, "iç hata", sub.endpoint)
    );

    expect(await notifyClientUsers(clientId, payload)).toMatchObject({ failed: 1, removed: 0 });
    expect((await db.pushSubscription.findUniqueOrThrow({ where: { id: sub.id } })).failCount).toBe(
      PUSH_MAX_FAILURES - 1
    );

    expect(await notifyClientUsers(clientId, payload)).toMatchObject({ failed: 0, removed: 1 });
    expect(await db.pushSubscription.count()).toBe(0);

    const logged = error.mock.calls.flat().map(String).join("\n");
    expect(logged).not.toContain(sub.endpoint);
    expect(logged).not.toContain(sub.p256dh);
  });

  it("ağ hatası (WebPushError değil) da sayılır; throw etmez", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await createClientUser(clientId);
    const sub = await subscribe(user.id);
    sendNotification.mockRejectedValue(new Error(`connect ETIMEDOUT ${sub.endpoint}`));
    await expect(notifyClientUsers(clientId, payload)).resolves.toMatchObject({ failed: 1 });
    expect((await db.pushSubscription.findUniqueOrThrow({ where: { id: sub.id } })).failCount).toBe(1);
  });

  it("DB patlasa da throw etmez", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Prisma delegesine `vi.spyOn` geri alınınca delegeyi bozuyor (sonraki
    // testlerde `findMany is not a function`); onun yerine GERÇEK bir Prisma
    // hatası: yanlış tipte id sorguyu doğrulamada patlatır.
    const badId = 42 as unknown as string;
    await expect(notifyClientUsers(badId, payload)).resolves.toMatchObject({ skipped: "error" });
  });

  it("aboneliği olmayan müşteride gönderim yok", async () => {
    expect(await notifyClientUsers(clientId, payload)).toMatchObject({ skipped: "no_subscriptions" });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("safePushUrl", () => {
  it.each([
    ["/portal", "/portal"],
    ["/portal/video/abc", "/portal/video/abc"],
    ["https://www.instagram.com/reel/x/", "https://www.instagram.com/reel/x/"],
    ["https://instagram.com/p/x/", "https://instagram.com/p/x/"],
    ["/portalx", "/portal"],
    ["//evil.example/portal", "/portal"],
    ["http://www.instagram.com/reel/x/", "/portal"],
    ["https://instagram.com.evil.example/", "/portal"],
    ["javascript:alert(1)", "/portal"],
    ["", "/portal"],
  ])("%s → %s", (input, expected) => {
    expect(safePushUrl(input)).toBe(expected);
  });
});

describe("notifyCaptionsReady (toplu, kısmalı)", () => {
  async function withSubscriber() {
    const user = await createClientUser(clientId);
    await subscribe(user.id);
  }

  it("partinin sonunda tek bildirim, doğru sayıyla", async () => {
    await withSubscriber();
    await createPortalPost(agencyId, clientId, { captionStatus: "ready" });
    const second = await createPortalPost(agencyId, clientId, { captionStatus: "generating" });

    // İlk video bitti ama ikincisi hâlâ yolda → bekle.
    await notifyCaptionsReady(clientId);
    expect(sendNotification).not.toHaveBeenCalled();

    await db.post.update({ where: { id: second.id }, data: { captionStatus: "ready" } });
    await notifyCaptionsReady(clientId);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendNotification.mock.calls[0][1])).toMatchObject({
      title: "2 video onayına hazır",
      url: "/portal",
      tag: "caption-hazir",
    });
  });

  it("son 2 dakikada gittiyse atlanır, sonra yeniden gider", async () => {
    await withSubscriber();
    await createPortalPost(agencyId, clientId, { captionStatus: "ready" });
    const t0 = new Date("2026-09-26T10:00:00Z");

    await notifyCaptionsReady(clientId, t0);
    await notifyCaptionsReady(clientId, new Date(t0.getTime() + 60_000));
    expect(sendNotification).toHaveBeenCalledTimes(1);

    await notifyCaptionsReady(clientId, new Date(t0.getTime() + CAPTION_READY_THROTTLE_MS + 1));
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("Upstash varsa kısma oradan: anahtar zaten varsa (başka instance gönderdi) atlanır", async () => {
    await withSubscriber();
    await createPortalPost(agencyId, clientId, { captionStatus: "ready" });
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "t";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ result: null }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await notifyCaptionsReady(clientId);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
      expect(body[0].slice(0, 2)).toEqual(["SET", `push:caption-ready:${clientId}`]);
      expect(body[0]).toContain("NX");
      expect(sendNotification).not.toHaveBeenCalled();
    } finally {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    }
  });

  it("onay kapalıysa gönderilmez (onaylanacak bir şey yok)", async () => {
    await withSubscriber();
    await db.publishSettings.create({ data: { clientId, requireApproval: false } });
    await createPortalPost(agencyId, clientId, { captionStatus: "ready" });
    await notifyCaptionsReady(clientId);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("takılmış (10 dk'dan eski) üretim partiyi sonsuza kadar bekletmez", async () => {
    await withSubscriber();
    await createPortalPost(agencyId, clientId, { captionStatus: "ready" });
    await createPortalPost(agencyId, clientId, {
      captionStatus: "pending",
      updatedAt: new Date(Date.now() - 11 * 60_000),
    });
    await notifyCaptionsReady(clientId);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendNotification.mock.calls[0][1]).title).toBe("1 video onayına hazır");
  });

  it("DB patlasa da throw etmez", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const badId = 42 as unknown as string;
    await expect(notifyCaptionsReady(badId)).resolves.toBeUndefined();
  });
});
