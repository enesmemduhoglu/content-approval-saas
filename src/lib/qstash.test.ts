import { afterEach, describe, expect, it } from "vitest";
import { authorizeQueueRequest, enqueueCaption } from "@/lib/qstash";

const SECRET = "x".repeat(40);

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  delete process.env.QSTASH_TOKEN;
  delete process.env.APP_URL;
});

function req(headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/queue/tick", { method: "POST", headers });
}

describe("authorizeQueueRequest", () => {
  it("imza ya da anahtar yoksa reddeder", async () => {
    expect(await authorizeQueueRequest(req(), "")).toBe(false);
  });

  it("CRON_SECRET tanımlı değilse Bearer de reddedilir", async () => {
    expect(await authorizeQueueRequest(req({ authorization: `Bearer ${SECRET}` }), "")).toBe(false);
  });

  it("doğru CRON_SECRET kabul edilir, yanlışı reddedilir", async () => {
    process.env.CRON_SECRET = SECRET;
    expect(await authorizeQueueRequest(req({ authorization: `Bearer ${SECRET}` }), "")).toBe(true);
    expect(await authorizeQueueRequest(req({ authorization: "Bearer yanlis" }), "")).toBe(false);
  });

  it("imza başlığı var ama imza anahtarları yoksa reddeder", async () => {
    process.env.CRON_SECRET = SECRET;
    expect(await authorizeQueueRequest(req({ "upstash-signature": "abc" }), "")).toBe(false);
  });

  it("geçersiz imzayı reddeder", async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = "sig_current";
    process.env.QSTASH_NEXT_SIGNING_KEY = "sig_next";
    expect(await authorizeQueueRequest(req({ "upstash-signature": "bozuk.jwt.imza" }), "{}")).toBe(
      false
    );
  });
});

describe("enqueueCaption", () => {
  it("yapılandırma yoksa throw etmez, sebebini döner", async () => {
    const res = await enqueueCaption("po1");
    expect(res.queued).toBe(false);
  });
});
