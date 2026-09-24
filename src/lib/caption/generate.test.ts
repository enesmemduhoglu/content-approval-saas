import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Anthropic'e gerçek istek atılmaz; hata sınıfları gerçek kalır ki
// sınıflandırma (`instanceof APIError`) gerçekten sınansın.
const create = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic {
    messages = { create };
  }
  return { ...actual, default: FakeAnthropic };
});

import { APIConnectionError, InternalServerError, BadRequestError } from "@anthropic-ai/sdk";
import {
  CAPTION_MODEL,
  DEFAULT_CAPTION_STYLE,
  generateCaption,
  resetAnthropicClientForTests,
} from "./generate";
import { CaptionStepError, InvalidModelOutputError } from "./errors";

function reply(payload: unknown, stop_reason = "end_turn") {
  return {
    stop_reason,
    stop_details: null,
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
  };
}

const input = {
  frameUrls: ["https://r2.test/kare-0.jpg", "https://r2.test/kare-1.jpg"],
  transcript: "Bugün present perfect öğreniyoruz.",
  captionStyle: "Samimi bir öğretmen sesi.",
};

/** Beklenen hatayı yakalar; testte tipli okunabilsin diye. */
async function failure(promise: Promise<unknown>): Promise<CaptionStepError> {
  return (await promise.then(
    () => {
      throw new Error("hata bekleniyordu");
    },
    (e: unknown) => e
  )) as CaptionStepError;
}

/** Son çağrının istek gövdesi ve kullanıcı mesajının düz metni. */
function lastRequest() {
  const [body, options] = create.mock.calls.at(-1)!;
  const content = body.messages[0].content as Array<{ type: string; text?: string }>;
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { body, options, content, text };
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anahtar");
  resetAnthropicClientForTests();
  create.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("generateCaption — istek", () => {
  it("kareleri görsel blok, transkripti metin olarak doğru modele yollar", async () => {
    create.mockResolvedValue(reply({ aciklama: "a", hashtagler: [], altText: "b" }));
    await generateCaption(input);

    const { body, content, text } = lastRequest();
    expect(body.model).toBe(CAPTION_MODEL);
    expect(body.output_config.format.type).toBe("json_schema");
    expect(content.filter((b) => b.type === "image")).toEqual([
      { type: "image", source: { type: "url", url: input.frameUrls[0] } },
      { type: "image", source: { type: "url", url: input.frameUrls[1] } },
    ]);
    expect(text).toContain(input.transcript);
  });

  it("uydurma yasağı ve müşteri talimatı system prompt'ta", async () => {
    create.mockResolvedValue(reply({}));
    await generateCaption(input);
    const { body } = lastRequest();
    expect(body.system).toContain("Videoda geçmeyen bilgi uydurma");
    expect(body.system).toContain("Samimi bir öğretmen sesi.");
  });

  it("captionStyle boşsa genel talimat kullanılır", async () => {
    create.mockResolvedValue(reply({}));
    await generateCaption({ ...input, captionStyle: "  " });
    expect(lastRequest().body.system).toContain(DEFAULT_CAPTION_STYLE);
  });

  it("yeniden üretme notu ve mevcut caption prompt'a girer", async () => {
    create.mockResolvedValue(reply({}));
    await generateCaption({
      ...input,
      note: "daha kısa olsun",
      currentCaption: "Eski uzun caption",
    });
    const { text } = lastRequest();
    expect(text).toContain("daha kısa olsun");
    expect(text).toContain("Eski uzun caption");
  });

  it("not yoksa yeniden üretme bölümü eklenmez", async () => {
    create.mockResolvedValue(reply({}));
    await generateCaption(input);
    expect(lastRequest().text).not.toContain("<not>");
  });

  it("önceki denemenin sorunları prompt'a eklenir", async () => {
    create.mockResolvedValue(reply({}));
    await generateCaption({ ...input, previousProblems: ["Hashtag sayısı 4"] });
    expect(lastRequest().text).toContain("Hashtag sayısı 4");
  });

  it("boş transkripti konuşmasız video olarak belirtir", async () => {
    create.mockResolvedValue(reply({}));
    await generateCaption({ ...input, transcript: "" });
    expect(lastRequest().text).toContain("videoda konuşma yok");
  });

  it("zaman aşımını istek seçeneği olarak geçirir", async () => {
    create.mockResolvedValue(reply({}));
    await generateCaption({ ...input, timeoutMs: 12_345 });
    expect(lastRequest().options).toEqual({ timeout: 12_345 });
  });
});

describe("generateCaption — yanıt ve hatalar", () => {
  it("JSON çıktıyı çözüp döner", async () => {
    const payload = { aciklama: "x", hashtagler: ["#a"], altText: "y" };
    create.mockResolvedValue(reply(payload));
    await expect(generateCaption(input)).resolves.toEqual(payload);
  });

  it("çözülemeyen ya da kesilen çıktı InvalidModelOutputError", async () => {
    create.mockResolvedValue(reply("{bozuk"));
    await expect(generateCaption(input)).rejects.toBeInstanceOf(InvalidModelOutputError);
    create.mockResolvedValue(reply({ aciklama: "x" }, "max_tokens"));
    await expect(generateCaption(input)).rejects.toBeInstanceOf(InvalidModelOutputError);
  });

  it("ret kalıcı hatadır", async () => {
    create.mockResolvedValue({ ...reply(""), stop_reason: "refusal" });
    const error = await failure(generateCaption(input));
    expect(error).toBeInstanceOf(CaptionStepError);
    expect(error.retryable).toBe(false);
  });

  it("5xx ve bağlantı hatası geçici, 400 kalıcı", async () => {
    create.mockRejectedValueOnce(new InternalServerError(529, {}, "overloaded", new Headers()));
    expect((await failure(generateCaption(input))).retryable).toBe(true);

    create.mockRejectedValueOnce(new APIConnectionError({ message: "ağ yok" }));
    expect((await failure(generateCaption(input))).retryable).toBe(true);

    create.mockRejectedValueOnce(new BadRequestError(400, {}, "bad", new Headers()));
    const error = await failure(generateCaption(input));
    expect(error).toBeInstanceOf(CaptionStepError);
    expect(error.retryable).toBe(false);
  });

  it("anahtar yoksa istek atmadan kalıcı yapılandırma hatası verir", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    resetAnthropicClientForTests();
    const error = await failure(generateCaption(input));
    expect(error).toBeInstanceOf(CaptionStepError);
    expect(error.step).toBe("config");
    expect(create).not.toHaveBeenCalled();
  });
});
