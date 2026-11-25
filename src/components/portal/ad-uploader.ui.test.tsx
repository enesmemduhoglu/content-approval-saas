// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { AdUploader } from "./ad-uploader";
import type { ImageDeps } from "@/lib/ad-image-client";

const fetchMock = vi.fn();

/** Dosya adından boyut: "dik-…" 4:5, "uzun-…" 9:16 (Instagram dışı). */
const deps: ImageDeps = {
  decode: async (file) => {
    const name = (file as File).name;
    return name.startsWith("uzun")
      ? { width: 1080, height: 1920, source: {} as CanvasImageSource }
      : { width: 2160, height: 2700, source: {} as CanvasImageSource };
  },
  encode: async () => new Blob(["jpeg"], { type: "image/jpeg" }),
};

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const jpeg = (name: string) => new File(["x".repeat(100)], name, { type: "image/jpeg" });

function pick(files: File[]) {
  fireEvent.change(screen.getByLabelText("Reklam görseli seç"), { target: { files } });
}

describe("AdUploader", () => {
  it("taslak → R2 PUT → complete; oranı tutmayan görsel hiç gönderilmez", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/portal/ads/upload") {
        return new Response(
          JSON.stringify({ items: [{ adId: "ad1", putUrl: "https://r2.test/put/ad1" }] }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    render(<AdUploader deps={deps} />);
    pick([jpeg("dik-01.jpg"), jpeg("uzun-02.jpg")]);

    expect(await screen.findByText(/Reklam havuzuna eklendi/)).toBeTruthy();
    expect(screen.getByText(/Oran Instagram'a uygun değil \(1080×1920\)/)).toBeTruthy();

    const calls = fetchMock.mock.calls.map(([url, init]) => [url, init?.method]);
    expect(calls).toEqual([
      ["/api/portal/ads/upload", "POST"],
      ["https://r2.test/put/ad1", "PUT"],
      ["/api/portal/ads/ad1/complete", "POST"],
    ]);
    // Taslak isteğinde yalnızca uygun görsel, JPEG olarak.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      files: [{ contentType: "image/jpeg", size: 100, name: "dik-01.jpg" }],
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("taslak isteği reddedilirse (ör. depolama dolu) neden her görselde yazar", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Depolama dolu" }), { status: 403 })
    );
    render(<AdUploader deps={deps} />);
    pick([jpeg("dik-01.jpg")]);
    expect(await screen.findByText(/Yüklenemedi: Depolama dolu/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sunucu doğrulaması reddederse hata kartı", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/portal/ads/upload") {
        return new Response(JSON.stringify({ items: [{ adId: "ad1", putUrl: "https://r2.test/p" }] }), {
          status: 201,
        });
      }
      if (url.endsWith("/complete")) {
        return new Response(JSON.stringify({ error: "Görsel okunamadı — geçerli bir JPEG değil" }), {
          status: 400,
        });
      }
      return new Response(null, { status: 200 });
    });
    render(<AdUploader deps={deps} />);
    pick([jpeg("dik-01.jpg")]);
    expect(await screen.findByText(/geçerli bir JPEG değil/)).toBeTruthy();
  });

  it("50'den fazla görsel seçilirse hiçbir şey başlamaz", () => {
    render(<AdUploader deps={deps} />);
    pick(Array.from({ length: 51 }, (_, i) => jpeg(`dik-${i}.jpg`)));
    expect(screen.getByRole("alert").textContent).toContain("en fazla 50");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
