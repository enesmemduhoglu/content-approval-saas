import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import { PUSH_ENDPOINT_HEADER } from "@/lib/push-shared";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, portalCookie, portalRequest } from "@tests/helpers/portal";
import { DELETE, GET, POST } from "./route";

const ENDPOINT = "https://web.push.apple.com/QGz3cihaz-a";
const KEYS = { p256dh: "B".repeat(87), auth: "c".repeat(22) };
const valid = { endpoint: ENDPOINT, keys: KEYS };

let userA: { id: string; clientId: string };
let userB: { id: string; clientId: string };
let cookieA: string;
let cookieB: string;

function setVapid(on: boolean) {
  const vars = {
    VAPID_PUBLIC_KEY: "public-key-test",
    VAPID_PRIVATE_KEY: "private-key-test",
    VAPID_SUBJECT: "mailto:test@ornek.com",
  };
  for (const [key, value] of Object.entries(vars)) {
    if (on) process.env[key] = value;
    else delete process.env[key];
  }
}

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  setVapid(true);
  const agency = await createAgency();
  const client = await createClient(agency.id);
  userA = await createClientUser(client.id);
  userB = await createClientUser(client.id);
  cookieA = portalCookie(userA);
  cookieB = portalCookie(userB);
});

afterEach(() => setVapid(false));

const post = (body: unknown, cookie = cookieA, origin?: string) =>
  POST(portalRequest("/api/portal/push", { method: "POST", cookie, body, origin }));
const del = (body: unknown, cookie = cookieA, origin?: string) =>
  DELETE(portalRequest("/api/portal/push", { method: "DELETE", cookie, body, origin }));

function getReq(cookie?: string, endpoint?: string): Request {
  const req = portalRequest("/api/portal/push", { cookie });
  if (endpoint) req.headers.set(PUSH_ENDPOINT_HEADER, endpoint);
  return req;
}

describe("POST /api/portal/push", () => {
  it("aboneliği kaydeder; yanıtta anahtar YOK", async () => {
    const res = await post(valid);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEYS.p256dh);
    const row = await db.pushSubscription.findUniqueOrThrow({ where: { endpoint: ENDPOINT } });
    expect(row).toMatchObject({ clientUserId: userA.id, p256dh: KEYS.p256dh, auth: KEYS.auth, failCount: 0 });
  });

  it("aynı endpoint ikinci kez: tek satır, anahtarlar yenilenir, hata sayacı sıfırlanır", async () => {
    await post(valid);
    await db.pushSubscription.update({ where: { endpoint: ENDPOINT }, data: { failCount: 3 } });
    const newKeys = { p256dh: "D".repeat(87), auth: "e".repeat(22) };
    expect((await post({ endpoint: ENDPOINT, keys: newKeys })).status).toBe(200);
    expect(await db.pushSubscription.count()).toBe(1);
    const row = await db.pushSubscription.findUniqueOrThrow({ where: { endpoint: ENDPOINT } });
    expect(row).toMatchObject({ p256dh: newKeys.p256dh, failCount: 0 });
  });

  it("başka kullanıcıya kayıtlı cihaz: satır bu kullanıcıya GEÇER (telefon el değiştirdi)", async () => {
    await post(valid, cookieB);
    expect((await post(valid, cookieA)).status).toBe(200);
    const rows = await db.pushSubscription.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].clientUserId).toBe(userA.id);
  });

  it("kullanıcı başına 10 cihaz tavanı: fazlası en eskiden silinir", async () => {
    for (let i = 0; i < 11; i += 1) {
      await db.pushSubscription.create({
        data: {
          clientUserId: userA.id,
          endpoint: `https://fcm.googleapis.com/fcm/send/eski-${i}`,
          p256dh: KEYS.p256dh,
          auth: KEYS.auth,
          createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
        },
      });
    }
    // Tavan dakikalık hız sınırından bağımsız: satırlar doğrudan yazıldı.
    expect((await post(valid)).status).toBe(200);
    const rows = await db.pushSubscription.findMany({ where: { clientUserId: userA.id } });
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.endpoint)).toContain(ENDPOINT);
    expect(rows.map((r) => r.endpoint)).not.toContain("https://fcm.googleapis.com/fcm/send/eski-0");
  });

  it("oturumsuz 401", async () => {
    expect((await POST(portalRequest("/api/portal/push", { method: "POST", body: valid }))).status).toBe(401);
  });

  it("yabancı origin 403 — ve hiçbir şey yazılmaz", async () => {
    expect((await post(valid, cookieA, "https://evil.example")).status).toBe(403);
    expect(await db.pushSubscription.count()).toBe(0);
  });

  it("hız sınırı: dakikada 10'dan fazla istek 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await post(valid)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it.each([
    ["gövde yok", undefined, "body"],
    ["http endpoint", { ...valid, endpoint: "http://web.push.apple.com/x" }, "endpoint"],
    ["izinli olmayan host (SSRF)", { ...valid, endpoint: "https://169.254.169.254/latest" }, "endpoint"],
    ["benzer host", { ...valid, endpoint: "https://fcm.googleapis.com.evil.example/x" }, "endpoint"],
    ["önek host", { ...valid, endpoint: "https://evilfcm.googleapis.com/x" }, "endpoint"],
    ["port'lu endpoint", { ...valid, endpoint: "https://web.push.apple.com:8443/x" }, "endpoint"],
    ["çok uzun endpoint", { ...valid, endpoint: `https://web.push.apple.com/${"x".repeat(1000)}` }, "endpoint"],
    ["anahtar yok", { endpoint: ENDPOINT }, "keys.p256dh"],
    ["kısa p256dh", { endpoint: ENDPOINT, keys: { ...KEYS, p256dh: "abc" } }, "keys.p256dh"],
    ["base64 olmayan auth", { endpoint: ENDPOINT, keys: { ...KEYS, auth: "!".repeat(22) } }, "keys.auth"],
  ])("%s → 400 (field: %s)", async (_label, body, field) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe(field);
    expect(await db.pushSubscription.count()).toBe(0);
  });

  it("VAPID yapılandırılmamışsa 503; abonelik yazılmaz", async () => {
    setVapid(false);
    expect((await post(valid)).status).toBe(503);
    expect(await db.pushSubscription.count()).toBe(0);
  });
});

describe("DELETE /api/portal/push", () => {
  it("kendi aboneliğini siler", async () => {
    await post(valid);
    expect((await del({ endpoint: ENDPOINT })).status).toBe(200);
    expect(await db.pushSubscription.count()).toBe(0);
  });

  it("IDOR: A, B'nin aboneliğini silemez (404, satır yerinde)", async () => {
    await post(valid, cookieB);
    expect((await del({ endpoint: ENDPOINT }, cookieA)).status).toBe(404);
    const row = await db.pushSubscription.findUniqueOrThrow({ where: { endpoint: ENDPOINT } });
    expect(row.clientUserId).toBe(userB.id);
  });

  it("IDOR: başka müşterinin kullanıcısı da silemez", async () => {
    const agency = await createAgency();
    const otherClient = await createClient(agency.id);
    const stranger = await createClientUser(otherClient.id);
    await post(valid, cookieB);
    expect((await del({ endpoint: ENDPOINT }, portalCookie(stranger))).status).toBe(404);
    expect(await db.pushSubscription.count()).toBe(1);
  });

  it("yabancı origin 403 — satır yerinde", async () => {
    await post(valid);
    expect((await del({ endpoint: ENDPOINT }, cookieA, "https://evil.example")).status).toBe(403);
    expect(await db.pushSubscription.count()).toBe(1);
  });

  it("geçersiz gövde 400", async () => {
    expect((await del({ endpoint: 5 })).status).toBe(400);
    expect((await del(undefined)).status).toBe(400);
  });

  it("oturumsuz 401", async () => {
    expect(
      (await DELETE(portalRequest("/api/portal/push", { method: "DELETE", body: { endpoint: ENDPOINT } }))).status
    ).toBe(401);
  });
});

describe("GET /api/portal/push", () => {
  it("public anahtar + bu cihaz bu kullanıcıya kayıtlı mı; private anahtar sızmaz", async () => {
    await post(valid);
    const mine = await (await GET(getReq(cookieA, ENDPOINT))).json();
    expect(mine).toEqual({ publicKey: "public-key-test", subscribed: true });

    // Aynı cihaz, başka kullanıcı: kayıtlı DEĞİL (satır A'nın).
    const theirs = await GET(getReq(cookieB, ENDPOINT));
    const text = await theirs.text();
    expect(JSON.parse(text)).toEqual({ publicKey: "public-key-test", subscribed: false });
    expect(text).not.toContain("private-key-test");
  });

  it("endpoint başlığı yoksa subscribed: false; env yoksa publicKey: null", async () => {
    expect(await (await GET(getReq(cookieA))).json()).toEqual({ publicKey: "public-key-test", subscribed: false });
    setVapid(false);
    expect((await (await GET(getReq(cookieA))).json()).publicKey).toBeNull();
  });

  it("oturumsuz 401", async () => {
    expect((await GET(getReq(undefined, ENDPOINT))).status).toBe(401);
  });
});
