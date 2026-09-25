import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Uç nokta gerçek `runCaption` ile sınanır; yalnızca dış servisler mock'lu.
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

import { ApiError } from "@fal-ai/client";
import { POST } from "./route";
import { db } from "@/lib/db";
import { resetStorageClientForTests, videoKey } from "@/lib/storage-r2";
import { resetFalClientForTests } from "@/lib/caption/transcribe";
import { resetAnthropicClientForTests } from "@/lib/caption/generate";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";

const CRON_SECRET = "c".repeat(40);
const tags = Array.from({ length: 12 }, (_, i) => `#etiket${i}`);

function request(postId: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/queue/caption/${postId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const authed = (postId: string, body: unknown = { postId }) =>
  request(postId, body, { authorization: `Bearer ${CRON_SECRET}` });

const params = (postId: string) => ({ params: Promise.resolve({ postId }) });

async function seedPost(source: "portal" | "agency" = "portal") {
  const agency = await createAgency();
  const client = await createClient(agency.id);
  const post = await db.post.create({
    data: {
      agencyId: agency.id,
      clientId: client.id,
      caption: "",
      source,
      captionStatus: source === "portal" ? "pending" : null,
    },
  });
  await db.post.update({
    where: { id: post.id },
    data: { videoKey: videoKey(client.id, post.id, "mp4") },
  });
  return post;
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
  vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "");
  vi.stubEnv("FAL_KEY", "fal-test");
  vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
  vi.stubEnv("R2_ACCOUNT_ID", "hesap");
  vi.stubEnv("R2_ACCESS_KEY_ID", "erisim");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "gizli");
  vi.stubEnv("R2_BUCKET", "kova");
  resetStorageClientForTests();
  resetFalClientForTests();
  resetAnthropicClientForTests();
  subscribe.mockReset();
  create.mockReset();
  subscribe.mockResolvedValue({ data: { text: "metin" } });
  create.mockResolvedValue({
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({ aciklama: "Açıklama", hashtagler: tags, altText: "Alt" }),
      },
    ],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/queue/caption/[postId] — yetki", () => {
  it("imzasız ve sırsız istek 401 alır, hiçbir iş yapılmaz", async () => {
    const post = await seedPost();
    const res = await POST(request(post.id, { postId: post.id }), params(post.id));
    expect(res.status).toBe(401);
    expect(subscribe).not.toHaveBeenCalled();
    const after = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.captionStatus).toBe("pending");
  });

  it("geçersiz QStash imzası 401 alır", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "sig_current");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "sig_next");
    const post = await seedPost();
    const res = await POST(
      request(post.id, { postId: post.id }, { "upstash-signature": "bozuk.jwt.imza" }),
      params(post.id)
    );
    expect(res.status).toBe(401);
  });

  it("yanlış sır 401 alır", async () => {
    const post = await seedPost();
    const res = await POST(
      request(post.id, { postId: post.id }, { authorization: `Bearer ${"x".repeat(40)}` }),
      params(post.id)
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/queue/caption/[postId] — durum kodları", () => {
  it("başarılı üretim 200, yanıt caption metnini taşımaz", async () => {
    const post = await seedPost();
    const res = await POST(authed(post.id), params(post.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: "ready" });
    const after = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.captionStatus).toBe("ready");
  });

  it("not gövdeden okunup prompt'a taşınır", async () => {
    const post = await seedPost();
    await POST(authed(post.id, { postId: post.id, note: "emoji kullanma" }), params(post.id));
    const content = create.mock.calls[0][0].messages[0].content as Array<{ text?: string }>;
    expect(content.map((b) => b.text ?? "").join("\n")).toContain("emoji kullanma");
  });

  it("olmayan post ve portal olmayan post: 200 (QStash tekrar denemesin)", async () => {
    const agencyPost = await seedPost("agency");
    const res1 = await POST(authed(agencyPost.id), params(agencyPost.id));
    expect(res1.status).toBe(200);
    expect(await res1.json()).toMatchObject({ status: "skipped", reason: "not_portal" });

    const res2 = await POST(authed("yok"), params("yok"));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ status: "skipped", reason: "not_found" });
  });

  it("geçici dış hata 503 (QStash tekrar denesin)", async () => {
    const post = await seedPost();
    subscribe.mockRejectedValueOnce(new ApiError({ message: "down", status: 502 }));
    const res = await POST(authed(post.id), params(post.id));
    expect(res.status).toBe(503);
  });

  it("kalıcı hata (kurallara uymayan çıktı) 200", async () => {
    const post = await seedPost();
    create.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ aciklama: "", hashtagler: [], altText: "" }) }],
    });
    const res = await POST(authed(post.id), params(post.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: "failed" });
  });

  it("bozuk gövde ve uyuşmayan postId 200 + hata, iş yapılmaz", async () => {
    const post = await seedPost();
    const bozuk = await POST(authed(post.id, "{bozuk"), params(post.id));
    expect(bozuk.status).toBe(200);
    expect((await bozuk.json()).ok).toBe(false);

    const uyusmaz = await POST(authed(post.id, { postId: "baska" }), params(post.id));
    expect(uyusmaz.status).toBe(200);
    expect((await uyusmaz.json()).ok).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
  });
});
