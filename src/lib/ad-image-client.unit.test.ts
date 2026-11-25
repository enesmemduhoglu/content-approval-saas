import { describe, expect, it, vi } from "vitest";
import { MAX_ENCODE_EDGE, prepareAdImage, type ImageDeps } from "@/lib/ad-image-client";
import { MAX_AD_BYTES } from "@/lib/portal-validation";

// Saf: tarayıcı API'leri (createImageBitmap, canvas) enjekte ediliyor.
const source = {} as CanvasImageSource;
function deps(size: { width: number; height: number }, encodedBytes: number[] = [1000]): ImageDeps {
  let call = 0;
  return {
    decode: vi.fn(async () => ({ ...size, source })),
    encode: vi.fn(async () => new Blob([new Uint8Array(encodedBytes[Math.min(call++, encodedBytes.length - 1)])])),
  };
}
const file = (type: string, bytes = 100) => new File([new Uint8Array(bytes)], "a", { type });

describe("prepareAdImage", () => {
  it("sınırdaki JPEG dokunulmadan geçer", async () => {
    const d = deps({ width: 2160, height: 2700 });
    const input = file("image/jpeg");
    const out = await prepareAdImage(input, d);
    expect(out).toMatchObject({ ok: true, reencoded: false, width: 2160, height: 2700 });
    expect(out.ok && out.blob).toBe(input);
    expect(d.encode).not.toHaveBeenCalled();
  });

  it("PNG JPEG'e yeniden kodlanır; uzun kenar sınırına indirilir", async () => {
    const d = deps({ width: 4320, height: 5400 });
    const out = await prepareAdImage(file("image/png"), d);
    expect(out).toMatchObject({ ok: true, reencoded: true });
    expect(d.encode).toHaveBeenCalledWith(expect.anything(), 2160, MAX_ENCODE_EDGE, 0.9);
  });

  it("8 MB'ı aşan JPEG düşen kaliteyle yeniden denenir", async () => {
    const d = deps({ width: 2160, height: 2700 }, [MAX_AD_BYTES + 1, 1000]);
    const out = await prepareAdImage(file("image/jpeg", MAX_AD_BYTES + 1), d);
    expect(out).toMatchObject({ ok: true, reencoded: true });
    expect(vi.mocked(d.encode).mock.calls.map((c) => c[3])).toEqual([0.9, 0.82]);
  });

  it("hiçbir kalitede sığmazsa hata", async () => {
    const d = deps({ width: 2160, height: 2700 }, [MAX_AD_BYTES + 1]);
    expect(await prepareAdImage(file("image/png"), d)).toEqual({
      ok: false,
      error: "Görsel 8 MB'a sığdırılamadı",
    });
  });

  it("9:16 hikâye görseli seçimde reddedilir, kodlanmaz", async () => {
    const d = deps({ width: 1080, height: 1920 });
    const out = await prepareAdImage(file("image/jpeg"), d);
    expect(out.ok).toBe(false);
    expect(d.encode).not.toHaveBeenCalled();
  });

  it("açılamayan dosya hata döner", async () => {
    const d: ImageDeps = { decode: async () => Promise.reject(new Error("x")), encode: vi.fn() };
    expect((await prepareAdImage(file("image/heic"), d)).ok).toBe(false);
  });
});
