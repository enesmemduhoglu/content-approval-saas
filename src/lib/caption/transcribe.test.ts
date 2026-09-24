import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fal'a gerçek istek atılmaz; `ApiError` gerçek kalır ki durum koduna göre
// sınıflandırma gerçekten sınansın.
const subscribe = vi.hoisted(() => vi.fn());
vi.mock("@fal-ai/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fal-ai/client")>();
  return { ...actual, createFalClient: vi.fn(() => ({ subscribe })) };
});

import { ApiError } from "@fal-ai/client";
import { resetFalClientForTests, transcribe, WHISPER_MODEL } from "./transcribe";
import { CaptionStepError } from "./errors";

beforeEach(() => {
  vi.stubEnv("FAL_KEY", "test-anahtar");
  resetFalClientForTests();
  subscribe.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("transcribe", () => {
  it("fal-ai/whisper'ı imzalı URL ile çağırır (wizper değil)", async () => {
    subscribe.mockResolvedValue({ data: { text: " Merhaba ", chunks: [] }, requestId: "r" });
    await transcribe("https://r2.test/video.mp4?imza=1");
    expect(WHISPER_MODEL).toBe("fal-ai/whisper");
    const [model, opts] = subscribe.mock.calls[0];
    expect(model).toBe("fal-ai/whisper");
    expect(opts.input).toMatchObject({
      audio_url: "https://r2.test/video.mp4?imza=1",
      task: "transcribe",
      chunk_level: "segment",
    });
  });

  it("düz metni ve parçaları döner", async () => {
    subscribe.mockResolvedValue({
      data: {
        text: " I have been learning. ",
        chunks: [
          { text: " I have been ", timestamp: [0, 1.2] },
          { text: "  ", timestamp: [1.2, 1.3] },
          { text: "learning.", timestamp: [1.3, null] },
        ],
      },
    });
    const res = await transcribe("https://r2.test/v.mp4");
    expect(res.text).toBe("I have been learning.");
    expect(res.chunks).toEqual([
      { text: "I have been", start: 0, end: 1.2 },
      { text: "learning.", start: 1.3, end: null },
    ]);
  });

  it("konuşmasız video boş transkript döner, hata vermez", async () => {
    subscribe.mockResolvedValue({ data: { text: "", chunks: [] } });
    await expect(transcribe("https://r2.test/v.mp4")).resolves.toEqual({ text: "", chunks: [] });
  });

  it("zaman aşımı verilirse abortSignal geçirilir", async () => {
    subscribe.mockResolvedValue({ data: { text: "x" } });
    await transcribe("https://r2.test/v.mp4", { timeoutMs: 5_000 });
    expect(subscribe.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("5xx geçici, 422 kalıcı hata; mesajda URL taşınmaz", async () => {
    subscribe.mockRejectedValueOnce(new ApiError({ message: "down", status: 503 }));
    const gecici = await transcribe("https://r2.test/v.mp4").catch((e) => e);
    expect(gecici).toBeInstanceOf(CaptionStepError);
    expect(gecici.retryable).toBe(true);

    subscribe.mockRejectedValueOnce(
      new ApiError({ message: "https://r2.test/v.mp4?X-Amz-Signature=gizli indirilemedi", status: 422 })
    );
    const kalici = await transcribe("https://r2.test/v.mp4").catch((e) => e);
    expect(kalici.retryable).toBe(false);
    expect(kalici.detail).not.toContain("X-Amz-Signature");
    expect(kalici.publicReason).not.toContain("http");
  });

  it("FAL_KEY yoksa istek atmadan yapılandırma hatası", async () => {
    vi.stubEnv("FAL_KEY", "");
    resetFalClientForTests();
    const error = await transcribe("https://r2.test/v.mp4").catch((e) => e);
    expect(error).toBeInstanceOf(CaptionStepError);
    expect(error.step).toBe("config");
    expect(subscribe).not.toHaveBeenCalled();
  });
});
