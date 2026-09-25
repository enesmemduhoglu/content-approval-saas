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

import { UploadForm } from "./upload-form";

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
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["x"], name, { type: "video/mp4" });
  fireEvent.change(input, { target: { files: [file] } });
}

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
