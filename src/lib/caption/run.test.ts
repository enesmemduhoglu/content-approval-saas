import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dış servisler SDK seviyesinde mock'lanır; orkestrasyon, doğrulama, DB
// kilidi ve imzalı URL üretimi gerçek kalır.
const { subscribe, create } = vi.hoisted(() => ({ subscribe: vi.fn(), create: vi.fn() }));
vi.mock("@fal-ai/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fal-ai/client")>();
  return { ...actual, createFalClient: vi.fn(() => ({ subscribe })) };
});
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic {
    messages = { create };
  }
  return { ...actual, default: FakeAnthropic };
});
vi.mock("@/lib/alerts", () => ({ sendAlert: vi.fn() }));
// V7c: "onayına hazır" kancası; toplama/kısma mantığı `push.test.ts`te.
vi.mock("@/lib/push", () => ({ notifyCaptionsReady: vi.fn(async () => undefined) }));

import { ApiError } from "@fal-ai/client";
import { db } from "@/lib/db";
import { sendAlert } from "@/lib/alerts";
import { notifyCaptionsReady } from "@/lib/push";
import { frameKey, resetStorageClientForTests, videoKey } from "@/lib/storage-r2";
import { runCaption, STALE_AFTER_MS } from "./run";
import { resetFalClientForTests } from "./transcribe";
import { resetAnthropicClientForTests } from "./generate";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";

const mockAlert = vi.mocked(sendAlert);
const mockReady = vi.mocked(notifyCaptionsReady);

const tags = Array.from({ length: 12 }, (_, i) => `#etiket${i}`);
const VALID = {
  aciklama: "Gramer kitabına göre böyle söylenir.",
  hashtagler: tags,
  altText: "Bir el kâğıda cümle yazıyor.",
};

function reply(payload: unknown) {
  return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Claude'a giden son isteğin kullanıcı metni. */
function promptText(call = create.mock.calls.length - 1): string {
  const content = create.mock.calls[call][0].messages[0].content as Array<{
    type: string;
    text?: string;
  }>;
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

async function seedPortalPost(
  overrides: {
    captionStatus?: "pending" | "generating" | "ready" | "failed";
    transcript?: string | null;
    source?: "portal" | "agency";
    caption?: string;
    foreignKey?: boolean;
  } = {}
) {
  const agency = await createAgency();
  const client = await createClient(agency.id);
  await db.client.update({
    where: { id: client.id },
    data: { captionStyle: "Furkan'ın samimi öğretmen sesi." },
  });
  const post = await db.post.create({
    data: {
      agencyId: agency.id,
      clientId: client.id,
      caption: overrides.caption ?? "",
      status: "pending",
      source: overrides.source ?? "portal",
      captionStatus: overrides.captionStatus ?? "pending",
      transcript: overrides.transcript === undefined ? null : overrides.transcript,
    },
  });
  // Anahtarlar gerçek düzende: kapsam kontrolü (`keyBelongsToClient`) sınansın.
  const owner = overrides.foreignKey ? "baskaMusteri" : client.id;
  await db.post.update({
    where: { id: post.id },
    data: {
      videoKey: videoKey(owner, post.id, "mp4"),
      frameKeys: [0, 1, 2].map((i) => frameKey(client.id, post.id, i)),
    },
  });
  return { agency, client, post };
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("FAL_KEY", "fal-test");
  vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
  // İmzalama yerel bir hesap; sahte anahtarlarla ağ olmadan URL üretilir.
  vi.stubEnv("R2_ACCOUNT_ID", "hesap");
  vi.stubEnv("R2_ACCESS_KEY_ID", "erisim");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "gizli");
  vi.stubEnv("R2_BUCKET", "kova");
  resetStorageClientForTests();
  resetFalClientForTests();
  resetAnthropicClientForTests();
  subscribe.mockReset();
  create.mockReset();
  mockAlert.mockReset();
  mockReady.mockClear();
  subscribe.mockResolvedValue({ data: { text: "Bugün present perfect öğreniyoruz.", chunks: [] } });
  create.mockResolvedValue(reply(VALID));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runCaption — mutlu yol", () => {
  it("pending postu ready yapar, caption'ı yazar, transkripti saklar", async () => {
    const { post } = await seedPortalPost();
    const outcome = await runCaption(post.id);

    expect(outcome).toMatchObject({ status: "ready", altText: VALID.altText });
    const after = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.captionStatus).toBe("ready");
    expect(after.captionError).toBeNull();
    expect(after.caption).toBe(`${VALID.aciklama}\n\n${tags.join(" ")}`);
    expect(after.transcript).toBe("Bugün present perfect öğreniyoruz.");

    // Whisper'a ve Claude'a giden URL'ler imzalı ve doğru anahtarı gösteriyor.
    const audioUrl: string = subscribe.mock.calls[0][1].input.audio_url;
    expect(audioUrl).toContain(`videos/${post.id}.mp4`);
    expect(audioUrl).toContain("X-Amz-Signature");
    const images = create.mock.calls[0][0].messages[0].content.filter(
      (b: { type: string }) => b.type === "image"
    );
    expect(images).toHaveLength(3);
    expect(images[0].source.url).toContain(`frames/${post.id}/0.jpg`);
    expect(create.mock.calls[0][0].system).toContain("Furkan'ın samimi öğretmen sesi.");
  });

  it("transkript varsa Whisper tekrar çağrılmaz", async () => {
    const { post } = await seedPortalPost({ transcript: "Önceden alınmış metin" });
    await runCaption(post.id);
    expect(subscribe).not.toHaveBeenCalled();
    expect(promptText()).toContain("Önceden alınmış metin");
  });

  it("boş transkript de geçerli sonuçtur: konuşmasız videoda Whisper tekrar çağrılmaz", async () => {
    const { post } = await seedPortalPost({ transcript: "" });
    const outcome = await runCaption(post.id);
    expect(outcome.status).toBe("ready");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("yeniden üretme notu ve mevcut caption prompt'a girer", async () => {
    const { post } = await seedPortalPost({ transcript: "x", caption: "Eski caption metni" });
    await runCaption(post.id, { note: "daha kısa olsun" });
    const text = promptText();
    expect(text).toContain("daha kısa olsun");
    expect(text).toContain("Eski caption metni");
  });
});

describe("runCaption — kilit", () => {
  it("iki eşzamanlı çağrı tek üretim yapar", async () => {
    const { post } = await seedPortalPost();
    // Whisper yavaş: ikinci çağrı kilide birinci hâlâ işteyken çarpsın.
    subscribe.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ data: { text: "x" } }), 150))
    );

    const outcomes = await Promise.all([runCaption(post.id), runCaption(post.id)]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(["ready", "skipped"]);
    expect(outcomes.find((o) => o.status === "skipped")).toMatchObject({ reason: "busy" });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("ready postu yeniden üretmez (tamamlanmış işin QStash tekrarı)", async () => {
    const { post } = await seedPortalPost({ captionStatus: "ready", caption: "Elle düzenlendi" });
    expect(await runCaption(post.id)).toEqual({ status: "skipped", reason: "already_ready" });
    expect(create).not.toHaveBeenCalled();
    const after = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.caption).toBe("Elle düzenlendi");
  });

  it("taze generating postu almaz, 10 dakikadan eski takılı postu alır", async () => {
    const { post } = await seedPortalPost({ captionStatus: "generating" });
    expect(await runCaption(post.id)).toEqual({ status: "skipped", reason: "busy" });

    const eski = new Date(Date.now() - STALE_AFTER_MS - 60_000);
    await db.$executeRaw`UPDATE "Post" SET "updatedAt" = ${eski} WHERE id = ${post.id}`;
    expect((await runCaption(post.id)).status).toBe("ready");
  });

  it("portal postu olmayanı ve olmayan postu işlemez", async () => {
    const { post } = await seedPortalPost({ source: "agency" });
    expect(await runCaption(post.id)).toEqual({ status: "skipped", reason: "not_portal" });
    expect(await runCaption("yok-boyle-bir-post")).toEqual({
      status: "skipped",
      reason: "not_found",
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("runCaption — doğrulama ve hatalar", () => {
  it("geçersiz çıktıda sorunları söyleyerek bir kez yeniden üretir", async () => {
    const { post } = await seedPortalPost({ transcript: "x" });
    create
      .mockResolvedValueOnce(reply({ ...VALID, hashtagler: ["#tek"] }))
      .mockResolvedValueOnce(reply(VALID));

    expect((await runCaption(post.id)).status).toBe("ready");
    expect(create).toHaveBeenCalledTimes(2);
    expect(promptText(0)).not.toContain("reddedildi");
    expect(promptText(1)).toContain("Hashtag sayısı 1");
  });

  it("iki kez geçersiz çıktı → failed, üçüncü deneme yok, uyarı yok", async () => {
    const { post } = await seedPortalPost({ transcript: "x" });
    create.mockResolvedValue(reply({ ...VALID, altText: "" }));

    const outcome = await runCaption(post.id);
    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(create).toHaveBeenCalledTimes(2);
    const after = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.captionStatus).toBe("failed");
    expect(after.captionError).toContain("Alt text boş");
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it("çözülemeyen JSON da yeniden üretim hakkını kullanır", async () => {
    const { post } = await seedPortalPost({ transcript: "x" });
    create
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "{" }] })
      .mockResolvedValueOnce(reply(VALID));
    expect((await runCaption(post.id)).status).toBe("ready");
  });

  it("geçici dış hata → failed + uyarı + retryable; tekrar deneme kaldığı yerden sürer", async () => {
    const { post } = await seedPortalPost();
    subscribe.mockRejectedValueOnce(new ApiError({ message: "down", status: 503 }));

    const first = await runCaption(post.id);
    expect(first).toMatchObject({ status: "failed", retryable: true });
    let after = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.captionStatus).toBe("failed");
    expect(after.captionError).toBe("Transkript servisi hata verdi (503)");
    expect(mockAlert).toHaveBeenCalledWith(
      "caption:transcribe",
      expect.any(String),
      expect.objectContaining({ postId: post.id, retryable: true })
    );

    // QStash'in tekrarı: kilit failed postu yeniden alır.
    expect((await runCaption(post.id)).status).toBe("ready");
    after = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.captionError).toBeNull();
  });

  it("Whisper'dan sonra Claude patlarsa transkript kayıtlı kalır, tekrar Whisper'sız sürer", async () => {
    const { post } = await seedPortalPost();
    create.mockRejectedValueOnce(new Error("beklenmeyen"));

    expect((await runCaption(post.id)).status).toBe("failed");
    expect(subscribe).toHaveBeenCalledTimes(1);

    expect((await runCaption(post.id)).status).toBe("ready");
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("başka müşterinin önekindeki video anahtarı imzalanmaz", async () => {
    const { post } = await seedPortalPost({ foreignKey: true });
    const outcome = await runCaption(post.id);
    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(subscribe).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("R2 yapılandırılmamışsa kalıcı hata ve uyarı", async () => {
    vi.stubEnv("R2_BUCKET", "");
    resetStorageClientForTests();
    const { post } = await seedPortalPost();
    const outcome = await runCaption(post.id);
    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(mockAlert).toHaveBeenCalledWith("caption:config", expect.any(String), expect.anything());
  });

  it("hiçbir durumda throw etmez", async () => {
    const { post } = await seedPortalPost();
    subscribe.mockImplementation(() => {
      throw new TypeError("senkron patlama");
    });
    await expect(runCaption(post.id)).resolves.toMatchObject({ status: "failed" });
  });
});

describe("runCaption — 'onayına hazır' bildirimi (V7c)", () => {
  it("ready yazılınca müşteri için toplu bildirim kancası çağrılır", async () => {
    const { client, post } = await seedPortalPost({ transcript: "x" });
    expect((await runCaption(post.id)).status).toBe("ready");
    expect(mockReady).toHaveBeenCalledTimes(1);
    expect(mockReady).toHaveBeenCalledWith(client.id);
  });

  it("başarısız üretimde ve atlanan işte çağrılmaz", async () => {
    const { post } = await seedPortalPost({ transcript: "x" });
    create.mockResolvedValue(reply({ ...VALID, altText: "" }));
    expect((await runCaption(post.id)).status).toBe("failed");

    const { post: ready } = await seedPortalPost({ captionStatus: "ready", caption: "hazır" });
    expect((await runCaption(ready.id)).status).toBe("skipped");
    expect(mockReady).not.toHaveBeenCalled();
  });
});
