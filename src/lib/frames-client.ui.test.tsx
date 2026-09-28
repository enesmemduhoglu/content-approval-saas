// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractFrames,
  frameTimes,
  isRetryableFrameError,
  uploadFrameBlobs,
} from "./frames-client";

/**
 * Kare çıkarma ve kare yüklemesi. jsdom'da gerçek medya çözücü yok; `<video>`
 * öğesi olayları elle ateşleyen bir sahteyle değiştiriliyor. Amaç iOS için
 * eklenen adımların (DOM'a ekleme, çözücüyü uyandırma, `loadeddata`, seek'in
 * bir kez yeniden denenmesi) ve hata kodlarının sözleşmesi.
 */

describe("frameTimes", () => {
  it("aralıkların ortasını verir (0. saniye değil)", () => {
    expect(frameTimes(60, 6)).toEqual([5, 15, 25, 35, 45, 55]);
  });
});

describe("isRetryableFrameError", () => {
  it("yalnızca zaman aşımları yeniden denenir", () => {
    expect(isRetryableFrameError("metadata-timeout")).toBe(true);
    expect(isRetryableFrameError("loadeddata-timeout")).toBe(true);
    expect(isRetryableFrameError("seek-timeout")).toBe(true);
    expect(isRetryableFrameError("decode")).toBe(false);
    expect(isRetryableFrameError("bad-metadata")).toBe(false);
    expect(isRetryableFrameError(undefined)).toBe(false);
  });
});

describe("uploadFrameBlobs", () => {
  const frames = Array.from({ length: 6 }, (_, i) => new Blob([String(i)], { type: "image/jpeg" }));
  const urls = frames.map((_, i) => `https://r2/eski/${i}`);
  const noWait = async () => undefined;

  it("hepsi giderse düşen yok", async () => {
    const put = vi.fn(async () => undefined);
    expect(await uploadFrameBlobs(frames, urls, put, { wait: noWait })).toEqual({ uploaded: 6, failed: 0 });
    expect(put).toHaveBeenCalledTimes(6);
  });

  it("düşen kare bir kez yeniden denenir — hata artık yutulmuyor, sayılıyor", async () => {
    let first = true;
    const put = vi.fn(async (url: string) => {
      if (url.endsWith("/2") && first) {
        first = false;
        throw new Error("Yükleme reddedildi (403)");
      }
    });
    expect(await uploadFrameBlobs(frames, urls, put, { wait: noWait })).toEqual({ uploaded: 6, failed: 0 });
    expect(put).toHaveBeenCalledTimes(7);
  });

  it("yeniden deneme taze imzalarla; kalıcı hata sayılır", async () => {
    const put = vi.fn(async (url: string) => {
      if (url.includes("/eski/")) throw new Error("süresi doldu");
      if (url.endsWith("/5")) throw new Error("bağlantı koptu");
    });
    const freshUrls = vi.fn(async () => frames.map((_, i) => `https://r2/taze/${i}`));
    const result = await uploadFrameBlobs(frames, urls, put, { wait: noWait, freshUrls });
    expect(result).toEqual({ uploaded: 5, failed: 1 });
    expect(freshUrls).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(12);
  });

  it("URL'i olmayan kare düşmüş sayılır; taze imza alınamazsa eskileriyle denenir", async () => {
    const put = vi.fn(async () => undefined);
    const result = await uploadFrameBlobs(frames, urls.slice(0, 4), put, {
      wait: noWait,
      freshUrls: async () => {
        throw new Error("imza alınamadı");
      },
    });
    expect(result).toEqual({ uploaded: 4, failed: 2 });
  });
});

// ─── extractFrames ────────────────────────────────────────────────────────

type FakeOptions = {
  metadata?: "ok" | "never" | "error";
  duration?: number;
  width?: number;
  height?: number;
  readyState?: number;
  /** `play()` çağrılınca `loadeddata` gelsin mi (readyState < 2 iken). */
  loadedOnPlay?: boolean;
  /** n. seek isteği (0'dan) `seeked` üretsin mi. */
  seekOk?: (attempt: number) => boolean;
  noContext?: boolean;
};

function installFakeMedia(opts: FakeOptions = {}) {
  const originalCreate = document.createElement.bind(document);
  const state = {
    video: null as HTMLVideoElement | null,
    attachedDuringSeek: [] as boolean[],
    seekTimes: [] as number[],
    play: vi.fn(),
    drawImage: vi.fn(),
  };
  let seekAttempt = 0;

  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const el = originalCreate(tag);
    if (tag === "video") {
      const video = el as HTMLVideoElement;
      state.video = video;
      let readyState = opts.readyState ?? 4;
      const fire = (type: string) => queueMicrotask(() => video.dispatchEvent(new Event(type)));
      Object.defineProperties(video, {
        duration: { get: () => opts.duration ?? 30 },
        videoWidth: { get: () => opts.width ?? 1080 },
        videoHeight: { get: () => opts.height ?? 1920 },
        readyState: { get: () => readyState },
        src: {
          set: () => {
            if (opts.metadata === "never") return;
            fire(opts.metadata === "error" ? "error" : "loadedmetadata");
          },
          get: () => "",
        },
        currentTime: {
          set: (t: number) => {
            state.seekTimes.push(t);
            state.attachedDuringSeek.push(document.body.contains(video));
            const attempt = seekAttempt++;
            if ((opts.seekOk ?? (() => true))(attempt)) fire("seeked");
          },
          get: () => 0,
        },
      });
      video.play = () => {
        state.play();
        if (opts.loadedOnPlay) {
          readyState = 2;
          fire("loadeddata");
        }
        return Promise.resolve();
      };
      video.pause = () => undefined;
      video.load = () => undefined;
    }
    if (tag === "canvas") {
      const canvas = el as HTMLCanvasElement;
      canvas.getContext = (() =>
        opts.noContext ? null : { drawImage: state.drawImage }) as unknown as HTMLCanvasElement["getContext"];
      canvas.toBlob = (cb: BlobCallback) => cb(new Blob(["jpeg"], { type: "image/jpeg" }));
    }
    return el;
  }) as typeof document.createElement);
  return state;
}

describe("extractFrames", () => {
  const file = new Blob(["video"], { type: "video/quicktime" });

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("6 kare; öğe çıkarma boyunca DOM'da, sessiz + satır içi, sonra kaldırılır", async () => {
    const fake = installFakeMedia();
    const out = await extractFrames(file);
    expect(out.error).toBeUndefined();
    expect(out.probe).toEqual({ duration: 30, width: 1080, height: 1920 });
    expect(out.frames).toHaveLength(6);
    expect(fake.seekTimes).toEqual([2.5, 7.5, 12.5, 17.5, 22.5, 27.5]);
    expect(fake.attachedDuringSeek.every(Boolean)).toBe(true);
    expect(fake.video!.muted).toBe(true);
    expect(fake.video!.playsInline).toBe(true);
    expect(fake.play).toHaveBeenCalled();
    expect(document.body.contains(fake.video!)).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("stopIf true dönerse kare çıkarılmaz: ölçüm döner, hiç sarılmaz, öğe kaldırılır", async () => {
    const fake = installFakeMedia();
    const stopIf = vi.fn(() => true);
    const out = await extractFrames(file, { stopIf });
    expect(stopIf).toHaveBeenCalledWith({ duration: 30, width: 1080, height: 1920 });
    expect(out).toEqual({ probe: { duration: 30, width: 1080, height: 1920 }, frames: [] });
    expect(fake.seekTimes).toEqual([]);
    expect(fake.play).not.toHaveBeenCalled();
    expect(document.body.contains(fake.video!)).toBe(false);
  });

  it("stopIf false dönerse çıkarma olağan sürer", async () => {
    installFakeMedia();
    const out = await extractFrames(file, { stopIf: () => false });
    expect(out.frames).toHaveLength(6);
  });

  it("ilk kare çözülmemişse (readyState < 2) loadeddata beklenir", async () => {
    installFakeMedia({ readyState: 1, loadedOnPlay: true });
    const out = await extractFrames(file);
    expect(out.frames).toHaveLength(6);
    expect(out.error).toBeUndefined();
  });

  it("zaman aşımına uğrayan seek bir kez yeniden denenir", async () => {
    vi.useFakeTimers();
    const fake = installFakeMedia({ seekOk: (attempt) => attempt !== 0 });
    const pending = extractFrames(file);
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await pending;
    expect(out.frames).toHaveLength(6);
    expect(out.error).toBeUndefined();
    expect(fake.seekTimes).toHaveLength(7);
  });

  it("seek hiç tutmazsa kare yok, neden 'seek-timeout', ölçüm yine döner (90 sn kapısı için)", async () => {
    vi.useFakeTimers();
    const fake = installFakeMedia({ seekOk: () => false });
    const pending = extractFrames(file);
    await vi.advanceTimersByTimeAsync(25_000);
    const out = await pending;
    expect(out).toEqual({ probe: { duration: 30, width: 1080, height: 1920 }, frames: [], error: "seek-timeout" });
    expect(document.body.contains(fake.video!)).toBe(false);
  });

  it("kısmi başarı: tutan kareler döner, neden raporda kalır", async () => {
    vi.useFakeTimers();
    installFakeMedia({ seekOk: (attempt) => attempt < 4 });
    const pending = extractFrames(file);
    await vi.advanceTimersByTimeAsync(25_000);
    const out = await pending;
    expect(out.frames).toHaveLength(4);
    expect(out.error).toBe("seek-timeout");
  });

  it("ilk kare hiç çözülmedi ve sarma da tutmadıysa neden 'loadeddata-timeout'", async () => {
    vi.useFakeTimers();
    installFakeMedia({ readyState: 1, seekOk: () => false });
    const pending = extractFrames(file);
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await pending).error).toBe("loadeddata-timeout");
  });

  it("metadata gelmezse 'metadata-timeout', ölçüm yok", async () => {
    vi.useFakeTimers();
    const fake = installFakeMedia({ metadata: "never" });
    const pending = extractFrames(file);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual({ probe: null, frames: [], error: "metadata-timeout" });
    expect(document.body.contains(fake.video!)).toBe(false);
  });

  it("codec açılamazsa 'decode'", async () => {
    installFakeMedia({ metadata: "error" });
    expect(await extractFrames(file)).toEqual({ probe: null, frames: [], error: "decode" });
  });

  it("süre okunamazsa 'bad-metadata'", async () => {
    installFakeMedia({ duration: Infinity });
    expect((await extractFrames(file)).error).toBe("bad-metadata");
  });

  it("2d bağlam yoksa 'no-canvas', ölçüm döner", async () => {
    installFakeMedia({ noContext: true });
    const out = await extractFrames(file);
    expect(out.error).toBe("no-canvas");
    expect(out.probe).not.toBeNull();
  });
});
