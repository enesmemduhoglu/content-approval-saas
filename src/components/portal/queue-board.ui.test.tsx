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
    render(<QueueBoard cards={[card("a"), card("b")]} requireApproval />);
    expect(renderedOrder()).toEqual(["a", "b"]);
    expect(screen.getByText("Caption a")).toBeTruthy();
    expect(screen.getAllByText("Onay bekliyor")).toHaveLength(2);
  });

  it("aşağı oku: iyimser sıralama + iki komşuyla move isteği", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<QueueBoard cards={[card("a"), card("b"), card("c")]} requireApproval />);

    fireEvent.click(screen.getAllByRole("button", { name: "Aşağı taşı" })[0]);

    expect(renderedOrder()).toEqual(["b", "a", "c"]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/videos/a/move");
    expect(JSON.parse(init.body)).toEqual({ afterId: "b", beforeId: "c" });
  });

  it("yukarı oku en üste taşırken yalnızca beforeId gönderir", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<QueueBoard cards={[card("a"), card("b")]} requireApproval />);
    fireEvent.click(screen.getAllByRole("button", { name: "Yukarı taşı" })[1]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ beforeId: "a" });
  });

  it("sunucu reddederse sıra geri alınır ve hata gösterilir", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Kuyruk bu arada değişti" }), { status: 409 })
    );
    render(<QueueBoard cards={[card("a"), card("b")]} requireApproval />);
    fireEvent.click(screen.getAllByRole("button", { name: "Aşağı taşı" })[0]);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Kuyruk bu arada değişti");
    expect(renderedOrder()).toEqual(["a", "b"]);
    expect(refresh).toHaveBeenCalled();
  });

  it("ilk kartta yukarı, son kartta aşağı oku devre dışı", () => {
    render(<QueueBoard cards={[card("a"), card("b")]} requireApproval />);
    const up = screen.getAllByRole("button", { name: "Yukarı taşı" });
    const down = screen.getAllByRole("button", { name: "Aşağı taşı" });
    expect((up[0] as HTMLButtonElement).disabled).toBe(true);
    expect((down[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("boş kuyrukta yükleme sayfasına yönlendiren boş durum", () => {
    render(<QueueBoard cards={[]} requireApproval />);
    expect(screen.getByRole("link", { name: "Video yükle" }).getAttribute("href")).toBe("/portal/yukle");
  });

  it("yayın hatası kartı hatayı ve 'Tekrar dene' çağrısını gösterir", () => {
    render(
      <QueueBoard
        cards={[card("a", { status: "approved", publishStatus: "failed", publishError: "Token süresi doldu." })]}
        requireApproval
      />
    );
    expect(screen.getByText(/Token süresi doldu\./)).toBeTruthy();
    expect(screen.getByText("Tekrar dene")).toBeTruthy();
    expect(screen.getByText("Yayınlanamadı")).toBeTruthy();
  });

  it("tahmini zaman rozetin yanında yazar", () => {
    render(<QueueBoard cards={[card("a", { status: "approved" })]} requireApproval etas={{ a: "Yarın 19:00" }} />);
    expect(screen.getByText("Yarın 19:00")).toBeTruthy();
  });

  it("caption hazırlanırken kartta metin yerine durum yazar", () => {
    render(
      <QueueBoard cards={[card("a", { captionStatus: "generating", caption: "" })]} requireApproval />
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
  it("onay kapalıyken 'Onay bekliyor' gösterilmez — video onay beklemeyecek", () => {
    const labels = (requireApproval: boolean) =>
      portalBadges({ status: "pending", captionStatus: "ready", publishStatus: "idle" }, requireApproval).map(
        (b) => b.label
      );
    expect(labels(true)).toContain("Onay bekliyor");
    expect(labels(false)).not.toContain("Onay bekliyor");
  });

  it("yayın hatası 'Yayınlanamadı' rozeti çıkarır; yanına 'Onaylı' eklenmez", () => {
    const labels = portalBadges(
      { status: "approved", captionStatus: "ready", publishStatus: "failed" },
      true
    ).map((b) => b.label);
    expect(labels).toEqual(["Yayınlanamadı"]);
  });

  it("tonlar mobil tasarımın rozetleri: Onaylı lacivert, Onay bekliyor şeftali, hazırlanıyor gri", () => {
    const tone = (input: Parameters<typeof portalBadges>[0]) => portalBadges(input, true)[0].tone;
    expect(tone({ status: "approved", captionStatus: "ready", publishStatus: "idle" })).toBe("navy");
    expect(tone({ status: "pending", captionStatus: "ready", publishStatus: "idle" })).toBe("peach");
    expect(tone({ status: "pending", captionStatus: "generating", publishStatus: "idle" })).toBe("gray");
    expect(tone({ status: "approved", captionStatus: "ready", publishStatus: "failed" })).toBe("red");
  });
});
