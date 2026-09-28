// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

// Kare çıkarma gerçek bir <video> ister; jsdom'da yok. Konu akışın ne zaman
// başladığı, kareler değil.
const extractFrames = vi.fn();
const putWithProgress = vi.fn();
vi.mock("@/lib/frames-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frames-client")>()),
  extractFrames: (...args: unknown[]) => extractFrames(...args),
  putWithProgress: (...args: unknown[]) => putWithProgress(...args),
}));
vi.mock("@/lib/upload-resume-store", () => ({
  loadResume: async () => null,
  saveResume: async () => undefined,
  deleteResume: async () => undefined,
  pruneResume: async () => undefined,
}));

import { UploadForm, fileSize } from "./upload-form";
import { fileProblem, videoType } from "./use-video-upload";

const fetchMock = vi.fn();

beforeEach(() => {
  refresh.mockReset();
  extractFrames.mockReset().mockResolvedValue({ probe: null, frames: [] });
  putWithProgress.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url === "/api/portal/upload") {
      return Response.json({
        items: [{ postId: "p1", multipart: false, videoPutUrl: "https://r2/put", framePutUrls: [] }],
      });
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function pickVideo(name = "ders.mp4") {
  pickFiles([new File(["x"], name, { type: "video/mp4" })]);
}

function pickFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files } });
}

function uploadBody(): { files: { contentType: string; size: number }[] } {
  const call = fetchMock.mock.calls.find(([url]) => url === "/api/portal/upload");
  return JSON.parse((call![1] as RequestInit).body as string);
}

describe("videoType / fileProblem / fileSize", () => {
  const file = (name: string, type: string, size = 10) => new File(["x".repeat(size)], name, { type });

  it("izinli tip olduğu gibi kalır; boş ya da genel tip uzantıdan tamamlanır", () => {
    expect(videoType(file("a.mp4", "video/mp4"))).toBe("video/mp4");
    expect(videoType(file("a.MOV", ""))).toBe("video/quicktime");
    // 2026-09-28 analizi: bazı tarayıcılar .mov'u octet-stream veriyor.
    expect(videoType(file("IMG_1.MOV", "application/octet-stream"))).toBe("video/quicktime");
    expect(videoType(file("klip.m4v", "video/x-m4v"))).toBe("video/mp4");
    expect(videoType(file("notlar.txt", "text/plain"))).toBe("text/plain");
  });

  it("fileProblem sunucunun kuralını seçimde uygular", () => {
    expect(fileProblem(file("a.mp4", "video/mp4"))).toBeNull();
    expect(fileProblem(file("IMG_1.MOV", "application/octet-stream"))).toBeNull();
    expect(fileProblem(file("notlar.txt", "text/plain"))).toMatch(/MP4 ya da MOV/);
    expect(fileProblem(file("bos.mp4", "video/mp4", 0))).toMatch(/boş/);
    const big = file("buyuk.mp4", "video/mp4");
    Object.defineProperty(big, "size", { value: 301 * 1024 * 1024 });
    expect(fileProblem(big)).toMatch(/300 MB/);
  });

  it("fileSize: 1 MB altı KB, küçükte bir ondalık, büyükte tam sayı", () => {
    expect(fileSize(50 * 1024)).toBe("50 KB");
    expect(fileSize(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(fileSize(70 * 1024 * 1024 + 1)).toBe("70 MB");
  });
});

describe("UploadForm — dosya türü ve toplu seçim", () => {
  it("octet-stream gelen .mov video/quicktime olarak başlatılır ve yüklenir", async () => {
    render(<UploadForm />);
    pickFiles([new File(["x"], "IMG_1420.MOV", { type: "application/octet-stream" })]);
    await screen.findByText("Kuyruğa eklendi · caption hazırlanıyor");
    expect(uploadBody().files[0].contentType).toBe("video/quicktime");
    expect(putWithProgress).toHaveBeenCalledWith("https://r2/put", expect.any(File), "video/quicktime", expect.anything());
  });

  it("desteklenmeyen dosya yalnızca kendi satırında hata verir, diğerleri yüklenir", async () => {
    render(<UploadForm />);
    pickFiles([
      new File(["x"], "notlar.txt", { type: "text/plain" }),
      new File(["x"], "ders.mp4", { type: "video/mp4" }),
    ]);
    await screen.findByText("Kuyruğa eklendi · caption hazırlanıyor");
    expect(screen.getByText(/Yüklenemedi: Bu dosya yüklenemiyor/)).toBeTruthy();
    expect(uploadBody().files).toEqual([{ contentType: "video/mp4", size: 1 }]);
    // Uygunsuz dosya için kare çıkarılmaya bile çalışılmaz.
    expect(extractFrames).toHaveBeenCalledTimes(1);
  });

  it("süre/yön kontrolü kare çıkarmadan önce yapılabilsin diye stopIf verilir", async () => {
    render(<UploadForm />);
    pickVideo();
    await screen.findByText("Kuyruğa eklendi · caption hazırlanıyor");
    const opts = extractFrames.mock.calls[0][1] as { stopIf: (p: unknown) => boolean };
    expect(opts.stopIf({ duration: 120, width: 720, height: 1280 })).toBe(true);
    expect(opts.stopIf({ duration: 30, width: 1920, height: 1080 })).toBe(true);
    expect(opts.stopIf({ duration: 30, width: 720, height: 1280 })).toBe(false);
  });

  it("kare çıkarıldıysa kartta ilk kare önizleme olarak görünür", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/portal/upload"
        ? Response.json({
            items: [
              { postId: "p1", multipart: false, videoPutUrl: "https://r2/put", framePutUrls: ["https://r2/frame/0"] },
            ],
          })
        : Response.json({ ok: true })
    );
    extractFrames.mockResolvedValue({
      probe: { duration: 20, width: 720, height: 1280 },
      frames: [new Blob(["jpeg"], { type: "image/jpeg" })],
    });
    const { container } = render(<UploadForm />);
    pickVideo();
    await screen.findByText("Kuyruğa eklendi · caption hazırlanıyor");
    const img = container.querySelector<HTMLImageElement>("img.p-ucard-thumb");
    expect(img?.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
  });
});

describe("UploadForm — seçim = yükleme", () => {
  it("ayrı bir 'Yükle' düğmesi yok", () => {
    render(<UploadForm />);
    expect(screen.queryByRole("button", { name: /yükle/i })).toBeNull();
  });

  it("galeriden seçilen video düğmeye basmadan yüklenip kuyruğa eklenir", async () => {
    render(<UploadForm />);
    pickVideo();
    await screen.findByText("Kuyruğa eklendi · caption hazırlanıyor");
    expect(extractFrames).toHaveBeenCalledTimes(1);
    expect(putWithProgress).toHaveBeenCalledWith("https://r2/put", expect.any(File), "video/mp4", expect.anything());
    expect(fetchMock).toHaveBeenCalledWith("/api/portal/videos/p1/complete", expect.anything());
    expect(refresh).toHaveBeenCalled();
  });

  it("uygunsuz video seçilince yükleme başlamaz, hata kartta görünür", async () => {
    extractFrames.mockResolvedValue({ probe: { duration: 10, width: 1920, height: 1080 }, frames: [] });
    render(<UploadForm />);
    pickVideo("yatay.mp4");
    await screen.findByText(/Video yatay/);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/portal/upload", expect.anything());
  });

  it("yükleme sürerken seçici kapalı — ikinci seçim aynı videoyu iki kez eklemesin", async () => {
    let release!: () => void;
    extractFrames.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ probe: null, frames: [] });
      })
    );
    render(<UploadForm />);
    pickVideo();
    await waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true)
    );
    expect(screen.getByText("Yükleniyor…")).toBeTruthy();
    release();
    await screen.findByText("Kuyruğa eklendi · caption hazırlanıyor");
  });
});

describe("UploadForm — kare raporu", () => {
  const frameUrls = Array.from({ length: 6 }, (_, i) => `https://r2/frame/${i}`);
  const sixFrames = () => Array.from({ length: 6 }, () => new Blob(["j"], { type: "image/jpeg" }));

  function withFrameUrls() {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/portal/upload") {
        return Response.json({
          items: [{ postId: "p1", multipart: false, videoPutUrl: "https://r2/put", framePutUrls: frameUrls }],
        });
      }
      return Response.json({ ok: true });
    });
  }

  function completeBody(): unknown {
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/portal/videos/p1/complete");
    return JSON.parse((call![1] as RequestInit).body as string);
  }

  it("complete gövdesi kare raporunu taşır; kare yoksa not görünür", async () => {
    render(<UploadForm />);
    pickVideo();
    await screen.findByText("Kuyruğa eklendi · caption hazırlanıyor");
    expect(completeBody()).toEqual({ frames: { extracted: 0, uploadFailed: 0 } });
    expect(screen.getByText(/Kare çıkarılamadı/)).toBeTruthy();
  });

  it("zaman aşımıyla çıkarılamayan kareler yükleme sırasında bir kez daha denenir", async () => {
    withFrameUrls();
    extractFrames
      .mockResolvedValueOnce({ probe: null, frames: [], error: "seek-timeout" })
      .mockResolvedValueOnce({ probe: { duration: 20, width: 720, height: 1280 }, frames: sixFrames() });
    render(<UploadForm />);
    pickVideo();
    await screen.findByText("Kuyruğa eklendi · caption hazırlanıyor");
    expect(extractFrames).toHaveBeenCalledTimes(2);
    expect(putWithProgress).toHaveBeenCalledWith(frameUrls[0], expect.any(Blob), "image/jpeg");
    expect(completeBody()).toEqual({ frames: { extracted: 6, uploadFailed: 0 } });
    expect(screen.queryByText(/Kare çıkarılamadı/)).toBeNull();
  });

  it("codec hatası yeniden denenmez; neden rapora yazılır", async () => {
    extractFrames.mockResolvedValue({ probe: null, frames: [], error: "decode" });
    render(<UploadForm />);
    pickVideo();
    await screen.findByText("Kuyruğa eklendi · caption hazırlanıyor");
    expect(extractFrames).toHaveBeenCalledTimes(1);
    expect(completeBody()).toEqual({ frames: { extracted: 0, uploadFailed: 0, error: "decode" } });
  });

  it("yüklenemeyen kare yutulmaz, rapora sayılır", async () => {
    withFrameUrls();
    extractFrames.mockResolvedValue({ probe: { duration: 20, width: 720, height: 1280 }, frames: sixFrames() });
    putWithProgress.mockImplementation(async (url: string) => {
      if (url === frameUrls[3]) throw new Error("Yükleme reddedildi (403)");
    });
    render(<UploadForm />);
    pickVideo();
    await screen.findByText("Kuyruğa eklendi · caption hazırlanıyor", undefined, { timeout: 3000 });
    // 6 kare + 1 yeniden deneme + video
    expect(putWithProgress).toHaveBeenCalledTimes(8);
    expect(completeBody()).toEqual({ frames: { extracted: 6, uploadFailed: 1 } });
  });
});
