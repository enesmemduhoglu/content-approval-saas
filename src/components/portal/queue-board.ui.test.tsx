// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
  usePathname: () => "/portal",
}));

import { QueueBoard, moveBody, type QueueCard } from "./queue-board";
import { portalBadges } from "./portal-badges";

const card = (id: string, overrides: Partial<QueueCard> = {}): QueueCard => ({
  id,
  caption: `Caption ${id}`,
  status: "pending",
  captionStatus: "ready",
  publishStatus: "idle",
  publishError: null,
  coverUrl: `https://acc.r2.cloudflarestorage.com/get/${id}.jpg`,
  ...overrides,
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderedOrder(): string[] {
  const list = screen.getByRole("list", { name: "Yayın kuyruğu" });
  return within(list)
    .getAllByRole("link")
    .map((a) => a.getAttribute("href")?.split("/").pop() ?? "");
}

describe("QueueBoard", () => {
  it("kartları sırasıyla, kapak ve caption başıyla çizer", () => {
    render(<QueueBoard cards={[card("a"), card("b")]} />);
    expect(renderedOrder()).toEqual(["a", "b"]);
    expect(screen.getByText("Caption a")).toBeTruthy();
    // K33: bekleyen (onaysız) kartta onay rozeti yok.
    expect(screen.queryByText("Onay bekliyor")).toBeNull();
  });

  it("aşağı oku: iyimser sıralama + iki komşuyla move isteği", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<QueueBoard cards={[card("a"), card("b"), card("c")]} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Aşağı taşı" })[0]);

    expect(renderedOrder()).toEqual(["b", "a", "c"]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/videos/a/move");
    expect(JSON.parse(init.body)).toEqual({ afterId: "b", beforeId: "c" });
  });

  it("yukarı oku en üste taşırken yalnızca beforeId gönderir", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<QueueBoard cards={[card("a"), card("b")]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Yukarı taşı" })[1]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ beforeId: "a" });
  });

  it("sunucu reddederse sıra geri alınır ve hata gösterilir", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Kuyruk bu arada değişti" }), { status: 409 })
    );
    render(<QueueBoard cards={[card("a"), card("b")]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Aşağı taşı" })[0]);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Kuyruk bu arada değişti");
    expect(renderedOrder()).toEqual(["a", "b"]);
    expect(refresh).toHaveBeenCalled();
  });

  it("ilk kartta yukarı, son kartta aşağı oku devre dışı", () => {
    render(<QueueBoard cards={[card("a"), card("b")]} />);
    const up = screen.getAllByRole("button", { name: "Yukarı taşı" });
    const down = screen.getAllByRole("button", { name: "Aşağı taşı" });
    expect((up[0] as HTMLButtonElement).disabled).toBe(true);
    expect((down[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("boş kuyrukta yükleme sayfasına yönlendiren boş durum", () => {
    render(<QueueBoard cards={[]} />);
    expect(screen.getByRole("link", { name: "Video yükle" }).getAttribute("href")).toBe("/portal/yukle");
  });

  it("yayın hatası kartı ham metni değil hatanın türünü ve 'Tekrar dene' çağrısını gösterir", () => {
    render(
      <QueueBoard
        cards={[
          card("a", {
            status: "approved",
            publishStatus: "failed",
            publishError: "Error validating access token · type=OAuthException · code=190 · fbtrace_id=Ab1",
          }),
        ]}
      />
    );
    expect(screen.getByText("Instagram bağlantısı geçersiz. Video sırada bekliyor.")).toBeTruthy();
    expect(screen.queryByText(/fbtrace_id/)).toBeNull();
    expect(screen.getByText("Tekrar dene")).toBeTruthy();
    expect(screen.getByText("Yayınlanamadı")).toBeTruthy();
  });

  it("biçim hatasında çağrı 'Ne yapmalıyım?' olur (aynı dosyayla tekrar denemek boşuna)", () => {
    render(
      <QueueBoard
        cards={[
          card("a", {
            status: "approved",
            publishStatus: "failed",
            publishError: "Container c1 durumu ERROR: Media upload has failed with error code 2207026",
          }),
        ]}
      />
    );
    expect(screen.getByText("Instagram videoyu kabul etmedi. Video sırada bekliyor.")).toBeTruthy();
    expect(screen.getByText("Ne yapmalıyım?")).toBeTruthy();
  });

  it("tahmini zaman rozetin yanında yazar — bekleyen (onaysız) kartta da", () => {
    render(<QueueBoard cards={[card("a", { status: "pending" })]} etas={{ a: "Yarın 19:00" }} />);
    expect(screen.getByText("Yarın 19:00")).toBeTruthy();
    expect(screen.queryByText(/Onaylarsan/)).toBeNull();
  });

  it("caption hazırlanırken kartta metin yerine durum yazar", () => {
    render(
      <QueueBoard cards={[card("a", { captionStatus: "generating", caption: "" })]} />
    );
    expect(screen.getAllByText(/Caption hazırlanıyor/).length).toBeGreaterThan(0);
  });
});

describe("moveBody", () => {
  it("baş, orta ve son konum", () => {
    expect(moveBody(["x", "a", "b"], 0)).toEqual({ beforeId: "a" });
    expect(moveBody(["a", "x", "b"], 1)).toEqual({ afterId: "a", beforeId: "b" });
    expect(moveBody(["a", "b", "x"], 2)).toEqual({ afterId: "b" });
  });
});

describe("portalBadges", () => {
  it("K33: status hiçbir rozet üretmez — ne 'Onay bekliyor' ne 'Onaylı' ne 'Reddedildi'", () => {
    for (const status of ["pending", "approved", "rejected"] as const) {
      expect(portalBadges({ status, captionStatus: "ready", publishStatus: "idle" })).toEqual([]);
    }
  });

  it("yayın hatası 'Yayınlanamadı' rozeti çıkarır", () => {
    const labels = portalBadges({ status: "approved", captionStatus: "ready", publishStatus: "failed" }).map(
      (b) => b.label
    );
    expect(labels).toEqual(["Yayınlanamadı"]);
  });

  it("tonlar: yayınlandı lacivert, hazırlanıyor gri, hata kırmızı", () => {
    const tone = (input: Parameters<typeof portalBadges>[0]) => portalBadges(input)[0].tone;
    expect(tone({ status: "approved", captionStatus: "ready", publishStatus: "published" })).toBe("navy");
    expect(tone({ status: "pending", captionStatus: "generating", publishStatus: "idle" })).toBe("gray");
    expect(tone({ status: "approved", captionStatus: "ready", publishStatus: "failed" })).toBe("red");
  });
});
