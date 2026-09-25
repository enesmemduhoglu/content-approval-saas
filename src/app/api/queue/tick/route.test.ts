import { beforeEach, describe, expect, it, vi } from "vitest";

// Instagram, R2 ve e-posta dışarı çıkmaz. Kararı veren katmanlar (queue.ts,
// queue-db.ts, publish-post.ts) GERÇEK kalır — test edilen şey onların birlikte
// verdiği karar.
vi.mock("@/lib/instagram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instagram")>();
  return {
    ...actual,
    publishToInstagram: vi.fn(),
    checkMediaLiveness: vi.fn(),
    createReelContainer: vi.fn(),
    finalizeContainer: vi.fn(),
  };
});
vi.mock("@/lib/storage-r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-r2")>();
  return { ...actual, signGetUrl: vi.fn() };
});
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendRawEmail: vi.fn(),
    sendAgencyNoticeEmail: vi.fn(),
  };
});

vi.mock("@/lib/push", () => ({
  notifyClientUsers: vi.fn(async () => ({ sent: 1, removed: 0, failed: 0 })),
}));

import { GET, POST } from "./route";
import { notifyClientUsers } from "@/lib/push";
import { db } from "@/lib/db";
import { sendAgencyNoticeEmail, sendRawEmail } from "@/lib/email";
import { IGError, createReelContainer, finalizeContainer } from "@/lib/instagram";
import { signGetUrl } from "@/lib/storage-r2";
import { AUTO_APPROVAL_IP } from "@/lib/queue-db";
import { localWeekday } from "@/lib/queue";
import {
  createAgency,
  createClient,
  createInstagramClient,
  resetDb,
} from "@tests/helpers/db";
import { createPublishSettings, createQueuePost, slotMinutesAgo } from "@tests/helpers/queue";

const mockCreateReel = vi.mocked(createReelContainer);
const mockFinalize = vi.mocked(finalizeContainer);
const mockSign = vi.mocked(signGetUrl);
const mockRaw = vi.mocked(sendRawEmail);
const mockAgency = vi.mocked(sendAgencyNoticeEmail);
const mockPush = vi.mocked(notifyClientUsers);

const CRON_SECRET = "q".repeat(40);
const SIGNED = "https://r2.example/clients/x/videos/v.mp4?X-Amz-Signature=gizli";

const tickRequest = (secret: string | null = CRON_SECRET) =>
  new Request("http://localhost/api/queue/tick", {
    method: "POST",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    body: "",
  });

/** Gönderilen kuyruk e-postalarının konu satırları. */
const subjects = () => mockRaw.mock.calls.map((call) => call[0].subject);

let reelCounter = 0;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("APP_URL", "https://app.example");
  mockRaw.mockResolvedValue({ sent: true });
  mockAgency.mockResolvedValue({ sent: true });
  mockSign.mockResolvedValue(SIGNED);
  mockCreateReel.mockImplementation(async () => `reel-${++reelCounter}`);
  mockFinalize.mockImplementation(async ({ containerId }) => ({
    state: "published",
    mediaId: `media-${containerId}`,
    permalink: `https://instagram.com/reel/${containerId}/`,
  }));
});

/** Instagram bağlı müşteri + ayar; slot `minutesAgo` dakika önce. */
async function seed(
  options: {
    minutesAgo?: number[];
    requireApproval?: boolean;
    paused?: boolean;
    days?: (slotAts: Date[]) => number[];
  } = {}
) {
  const agency = await createAgency();
  const client = await createInstagramClient(agency.id);
  const slots = (options.minutesAgo ?? [5]).map((m) => slotMinutesAgo(m));
  await createPublishSettings(client.id, {
    slots: slots.map((s) => s.slot),
    days: options.days?.(slots.map((s) => s.slotAt)),
    requireApproval: options.requireApproval ?? true,
    paused: options.paused ?? false,
  });
  return { agency, client, slotAts: slots.map((s) => s.slotAt) };
}

describe("yetkilendirme", () => {
  it("imzasız istek 401", async () => {
    expect((await POST(tickRequest(null))).status).toBe(401);
    expect((await GET(tickRequest(null))).status).toBe(401);
  });

  it("yanlış sır 401", async () => {
    expect((await POST(tickRequest("x".repeat(40)))).status).toBe(401);
  });

  it("QStash imzası var ama anahtarlar tanımlı değil → 401", async () => {
    const res = await POST(
      new Request("http://localhost/api/queue/tick", {
        method: "POST",
        headers: { "upstash-signature": "sahte.imza.degeri" },
        body: "{}",
      })
    );
    expect(res.status).toBe(401);
  });

  it("CRON_SECRET boşsa yedek yol da kapalı", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(tickRequest())).status).toBe(401);
  });
});

describe("slot yayını", () => {
  it("onay açık + onaylı video → yayınlar, slotAt ve SlotRun yazılır, R2 imzalı URL verilir", async () => {
    const { agency, client, slotAts } = await seed();
    const post = await createQueuePost(agency.id, client.id);

    const res = await POST(tickRequest());
    expect(await res.json()).toMatchObject({ ok: true, published: 1 });

    expect(mockSign).toHaveBeenCalledWith(post.videoKey, 7 * 24 * 60 * 60);
    expect(mockCreateReel).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: SIGNED }));

    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.publishStatus).toBe("published");
    expect(saved.slotAt).toEqual(slotAts[0]);

    const runs = await db.slotRun.findMany({ where: { clientId: client.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "published", postId: post.id, slotAt: slotAts[0] });

    // Başarı e-postası TEK kez, müşteriye, Instagram linkiyle.
    expect(subjects()).toEqual(["Videon Instagram'da yayınlandı"]);
    expect(mockRaw.mock.calls[0][0].to).toBe(client.email);
    expect(mockRaw.mock.calls[0][0].text).toContain("https://instagram.com/reel/");
  });

  it("aynı slot ikinci tick'te tekrar işlenmez", async () => {
    const { agency, client } = await seed();
    await createQueuePost(agency.id, client.id);
    await createQueuePost(agency.id, client.id);

    await POST(tickRequest());
    const second = await (await POST(tickRequest())).json();

    expect(second).toMatchObject({ published: 0, lost: 0 });
    expect(mockCreateReel).toHaveBeenCalledTimes(1);
    expect(await db.post.count({ where: { publishStatus: "published" } })).toBe(1);
  });

  it("iki EŞZAMANLI tick → tek yayın", async () => {
    const { agency, client } = await seed();
    await createQueuePost(agency.id, client.id);
    await createQueuePost(agency.id, client.id);

    const [a, b] = await Promise.all([POST(tickRequest()), POST(tickRequest())]);
    const bodies = [await a.json(), await b.json()];

    expect(bodies.reduce((sum, body) => sum + body.published, 0)).toBe(1);
    expect(mockCreateReel).toHaveBeenCalledTimes(1);
    expect(await db.slotRun.count({ where: { clientId: client.id } })).toBe(1);
    expect(await db.post.count({ where: { publishStatus: "published" } })).toBe(1);
    expect(subjects()).toEqual(["Videon Instagram'da yayınlandı"]);
  });

  it("onay AÇIK + yalnızca onaysız video → yayın yok, empty + 'onaylı video yoktu' e-postası", async () => {
    const { agency, client } = await seed({ requireApproval: true });
    const post = await createQueuePost(agency.id, client.id, { status: "pending" });

    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ published: 0, empty: 1 });

    expect(mockCreateReel).not.toHaveBeenCalled();
    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.status).toBe("pending");
    expect(saved.publishStatus).toBe("idle");
    expect(await db.approvalAudit.count()).toBe(0);

    const run = await db.slotRun.findFirstOrThrow({ where: { clientId: client.id } });
    expect(run.outcome).toBe("empty");
    expect(subjects()).toEqual(["Bu saatte yayınlanacak onaylı video yoktu"]);
    expect(mockRaw.mock.calls[0][0].text).toContain("1 video onayını bekliyor");
  });

  it("onay AÇIK: baştaki onaysızsa sıradaki ilk ONAYLI yayınlanır", async () => {
    const { agency, client } = await seed({ requireApproval: true });
    const first = await createQueuePost(agency.id, client.id, { status: "pending" });
    const second = await createQueuePost(agency.id, client.id, { status: "approved" });

    await POST(tickRequest());

    expect((await db.post.findUniqueOrThrow({ where: { id: first.id } })).publishStatus).toBe(
      "idle"
    );
    expect((await db.post.findUniqueOrThrow({ where: { id: second.id } })).publishStatus).toBe(
      "published"
    );
  });

  it("kuyruk boşsa empty + 'kuyrukta video kalmadı' e-postası", async () => {
    await seed();
    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ empty: 1 });
    expect(subjects()).toEqual(["Kuyrukta yayınlanacak video kalmadı"]);
  });

  it("onay KAPALI → auto_approved audit (ip=system) + yayın", async () => {
    const { agency, client } = await seed({ requireApproval: false });
    const post = await createQueuePost(agency.id, client.id, { status: "pending" });

    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ published: 1 });

    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.status).toBe("approved");
    expect(saved.publishStatus).toBe("published");

    const audits = await db.approvalAudit.findMany({ where: { postId: post.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "auto_approved", ip: AUTO_APPROVAL_IP });
    expect(AUTO_APPROVAL_IP).toBe("system");
  });

  it("onay KAPALI olsa bile reddedilmiş video yayınlanmaz", async () => {
    const { agency, client } = await seed({ requireApproval: false });
    await createQueuePost(agency.id, client.id, { status: "rejected" });

    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ published: 0, empty: 1 });
    expect(mockCreateReel).not.toHaveBeenCalled();
  });

  it("caption hazır olmayan video seçilmez", async () => {
    const { agency, client } = await seed();
    await createQueuePost(agency.id, client.id, { captionStatus: "generating" });

    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ published: 0, empty: 1 });
    expect(mockCreateReel).not.toHaveBeenCalled();
  });

  it("hata kuyruğu durdurmaz: ilk slot patlar, sonraki slot sıradakini yayınlar", async () => {
    const { agency, client, slotAts } = await seed({ minutesAgo: [10, 5] });
    const first = await createQueuePost(agency.id, client.id);
    const second = await createQueuePost(agency.id, client.id);
    mockCreateReel.mockRejectedValueOnce(
      new IGError("Video indirilemedi", { error: { code: 9004, fbtrace_id: "Axyz" } })
    );

    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ published: 1, failed: 1 });

    const a = await db.post.findUniqueOrThrow({ where: { id: first.id } });
    const b = await db.post.findUniqueOrThrow({ where: { id: second.id } });
    expect(a.publishStatus).toBe("failed");
    expect(a.slotAt).toEqual(slotAts[0]);
    expect(b.publishStatus).toBe("published");
    expect(b.slotAt).toEqual(slotAts[1]);

    const runs = await db.slotRun.findMany({
      where: { clientId: client.id },
      orderBy: { slotAt: "asc" },
    });
    expect(runs.map((r) => [r.outcome, r.postId])).toEqual([
      ["failed", first.id],
      ["published", second.id],
    ]);

    // Hata e-postası müşteriye + ekibe; başarı e-postası müşteriye.
    expect(subjects()).toEqual(["Video yayınlanamadı", "Videon Instagram'da yayınlandı"]);
    expect(mockRaw.mock.calls[0][0].text).toContain("https://app.example/portal");
    expect(mockAgency).toHaveBeenCalledTimes(1);
    expect(mockAgency.mock.calls[0][0]).toMatchObject({ event: "queue_failed" });
  });

  it("failed video sonraki tick'te kendiliğinden yeniden denenmez", async () => {
    const { agency, client } = await seed();
    await createQueuePost(agency.id, client.id, { publishStatus: "failed" });

    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ published: 0, empty: 1 });
    expect(mockCreateReel).not.toHaveBeenCalled();
  });
});

describe("duraklatma ve kaçırılmış slot", () => {
  it("paused → SlotRun(paused), yayın yok, e-posta yok", async () => {
    const { agency, client } = await seed({ paused: true });
    await createQueuePost(agency.id, client.id);

    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ paused: 1, published: 0 });
    expect(mockCreateReel).not.toHaveBeenCalled();
    expect(mockRaw).not.toHaveBeenCalled();
    const run = await db.slotRun.findFirstOrThrow({ where: { clientId: client.id } });
    expect(run.outcome).toBe("paused");
  });

  it("1 saatten eski slot → skipped, yayın yok (K8)", async () => {
    const { agency, client } = await seed({ minutesAgo: [90] });
    await createQueuePost(agency.id, client.id);

    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ skipped: 1, published: 0 });
    expect(mockCreateReel).not.toHaveBeenCalled();
    const run = await db.slotRun.findFirstOrThrow({ where: { clientId: client.id } });
    expect(run.outcome).toBe("skipped");
  });

  it("ayarı olmayan müşterinin kuyruğuna dokunulmaz", async () => {
    const agency = await createAgency();
    const client = await createInstagramClient(agency.id);
    await createQueuePost(agency.id, client.id);

    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ clients: 0, published: 0 });
    expect(mockCreateReel).not.toHaveBeenCalled();
  });
});

describe("yayın günleri (V8)", () => {
  // Slot gerçek saatten kuruluyor; gün de slotun İstanbul'daki YEREL günü —
  // test gece yarısına denk gelse bile "bugün" UTC'ye göre okunmasın.
  const otherDays = ([at]: Date[]) =>
    [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== localWeekday(at, "Europe/Istanbul"));

  it("seçili olmayan günde slot doğmaz: SlotRun yok, yayın yok, 'slot boş' e-postası/bildirimi yok", async () => {
    const { agency, client } = await seed({ days: otherDays });
    const post = await createQueuePost(agency.id, client.id);

    expect(await (await POST(tickRequest())).json()).toMatchObject({ ok: true, published: 0 });
    expect(await db.slotRun.count({ where: { clientId: client.id } })).toBe(0);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).publishStatus).toBe("idle");
    expect(mockCreateReel).not.toHaveBeenCalled();
    expect(mockRaw).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("aynı saat, bugün seçiliyken yayınlanır", async () => {
    const { agency, client } = await seed({
      days: ([at]) => [localWeekday(at, "Europe/Istanbul")],
    });
    await createQueuePost(agency.id, client.id);
    expect(await (await POST(tickRequest())).json()).toMatchObject({ ok: true, published: 1 });
    expect(await db.slotRun.count({ where: { clientId: client.id } })).toBe(1);
  });
});

describe("Instagram hazır değil", () => {
  it("bağlı değilse video HARCANMAZ: slot failed, post idle kalır, e-posta gider", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    const { slot } = slotMinutesAgo(5);
    await createPublishSettings(client.id, { slots: [slot] });
    const post = await createQueuePost(agency.id, client.id);

    const body = await (await POST(tickRequest())).json();
    expect(body).toMatchObject({ failed: 1, published: 0 });

    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.publishStatus).toBe("idle");
    expect(saved.slotAt).toBeNull();
    expect(subjects()).toEqual(["Yayın yapılamadı: Instagram bağlantısı"]);
    expect(mockAgency).toHaveBeenCalledTimes(1);
  });
});

describe("çok turlu video yayını", () => {
  it("Instagram işlerken slot sonucu boş kalır; sonraki tick bitirir, e-posta TEK kez gider", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    mockFinalize.mockResolvedValueOnce({ state: "processing", lastStatus: "IN_PROGRESS" });

    const first = await (await POST(tickRequest())).json();
    expect(first).toMatchObject({ publishing: 1, published: 0 });
    expect(mockRaw).not.toHaveBeenCalled();
    let run = await db.slotRun.findFirstOrThrow({ where: { clientId: client.id } });
    expect(run).toMatchObject({ outcome: null, postId: post.id });

    // Sonraki tick (5 dk sonra): aynı slotu tekrar işlemez, açık container'ı
    // ilerletir. Bir dakikadan taze container'a dokunulmadığı için zaman geri alınır.
    await db.post.update({
      where: { id: post.id },
      data: { containerAt: new Date(Date.now() - 5 * 60_000) },
    });
    const second = await (await POST(tickRequest())).json();
    expect(second).toMatchObject({ resumed: 1, published: 1 });
    expect(mockCreateReel).toHaveBeenCalledTimes(1);

    run = await db.slotRun.findFirstOrThrow({ where: { clientId: client.id } });
    expect(run.outcome).toBe("published");

    // Üçüncü tick: yapılacak iş yok, e-posta tekrar gitmez.
    await POST(tickRequest());
    expect(subjects()).toEqual(["Videon Instagram'da yayınlandı"]);
  });
});

describe("slot boş telefon bildirimi (V7c — e-postaya EK kanal)", () => {
  it("onaylı video yok → 'Bu saatte onaylı video yoktu' + bekleyen sayısı, kuyruğa gider", async () => {
    const { agency, client } = await seed({ requireApproval: true });
    await createQueuePost(agency.id, client.id, { status: "pending" });

    await POST(tickRequest());

    expect(subjects()).toEqual(["Bu saatte yayınlanacak onaylı video yoktu"]);
    expect(mockPush).toHaveBeenCalledTimes(1);
    const [clientId, payload] = mockPush.mock.calls[0];
    expect(clientId).toBe(client.id);
    expect(payload).toMatchObject({ title: "Bu saatte onaylı video yoktu", url: "/portal", tag: "slot-bos" });
    expect(payload.body).toContain("1 video onayını bekliyor");
  });

  it("kuyruk boş ve Instagram bağlı değil de bildirilir", async () => {
    await seed();
    await POST(tickRequest());
    expect(mockPush.mock.calls.map(([, p]) => p.title)).toEqual(["Kuyrukta video kalmadı"]);

    mockPush.mockClear();
    const agency = await createAgency();
    const client = await createClient(agency.id);
    await createPublishSettings(client.id, { slots: [slotMinutesAgo(5).slot] });
    await createQueuePost(agency.id, client.id);
    await POST(tickRequest());
    expect(mockPush).toHaveBeenCalledWith(
      client.id,
      expect.objectContaining({ title: "Yayın yapılamadı: Instagram bağlantısı" })
    );
  });

  it("e-posta patlasa da bildirim gider; tick düşmez", async () => {
    const { agency, client } = await seed({ requireApproval: true });
    await createQueuePost(agency.id, client.id, { status: "pending" });
    mockRaw.mockRejectedValue(new Error("resend çöktü"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await POST(tickRequest())).status).toBe(200);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("yayın olan slotta 'slot boş' bildirimi yok", async () => {
    const { agency, client } = await seed({ requireApproval: true });
    await createQueuePost(agency.id, client.id, { status: "approved" });
    await POST(tickRequest());
    // Tek bildirim yayın sonucu (publish-post kancası); slot boş değil.
    expect(mockPush.mock.calls.map(([, p]) => p.title)).toEqual(["Videon yayınlandı"]);
  });
});
