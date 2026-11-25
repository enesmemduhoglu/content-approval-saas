// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { AdPool, withLocalNext, type AdCardView } from "./ad-pool";

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

function card(id: string, over: Partial<AdCardView> = {}): AdCardView {
  return {
    id,
    caption: "",
    coverUrl: `https://r2.test/${id}.jpg`,
    state: "queued",
    publishError: null,
    igPermalink: null,
    publishedLabel: null,
    sourceName: `${id}.jpg`,
    ...over,
  };
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe("AdPool", () => {
  it("havuz sırayla, sıradaki ve hata rozetleriyle", () => {
    render(
      <AdPool
        pool={[card("01", { state: "next" }), card("02"), card("03", { state: "failed" })]}
        published={[]}
        defaultCaption="Varsayılan"
      />
    );
    expect(screen.getByRole("heading", { name: "Havuzda 3 reklam" })).toBeTruthy();
    const tiles = within(screen.getByRole("list", { name: "Reklam havuzu" })).getAllByRole("button");
    expect(tiles.map((t) => t.getAttribute("aria-label"))).toEqual([
      "1. reklam · Sıradaki · 01.jpg",
      "2. reklam · 02.jpg",
      "3. reklam · Hata · 03.jpg",
    ]);
  });

  it("boş havuz bunu söyler", () => {
    render(<AdPool pool={[]} published={[]} defaultCaption="" />);
    expect(screen.getByText(/Havuz boş/)).toBeTruthy();
  });

  it("reklama özel metin kaydedilir (PATCH) ve sayfa yenilenir", async () => {
    fetchMock.mockResolvedValue(ok());
    render(<AdPool pool={[card("01", { state: "next" })]} published={[]} defaultCaption="Varsayılan" />);
    fireEvent.click(screen.getByRole("button", { name: /1\. reklam/ }));
    const dialog = screen.getByRole("dialog");
    const textarea = within(dialog).getByLabelText("Bu reklamın metni");
    expect(textarea.getAttribute("placeholder")).toBe("Varsayılan");
    fireEvent.change(textarea, { target: { value: "Bu reklamın metni" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Metni kaydet" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/ads/01");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ caption: "Bu reklamın metni" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it("silme düğmesi kırmızı; sayfa açıkken arka sayfa kilitli, kapanınca serbest (V12c)", () => {
    render(<AdPool pool={[card("01")]} published={[]} defaultCaption="" />);
    fireEvent.click(screen.getByRole("button", { name: /1\. reklam/ }));
    expect(screen.getByRole("button", { name: "Reklamı sil" }).className).toContain("p-btn--danger");
    expect(document.body.style.position).toBe("fixed");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.position).toBe("");
  });

  it("ipucu basılı tutup sürüklemeyi söyler", () => {
    render(<AdPool pool={[card("01"), card("02")]} published={[]} defaultCaption="" />);
    expect(screen.getByText("Basılı tut, sürükleyerek sırala")).toBeTruthy();
  });

  it("silme ayrı onay ister, onaydan sonra DELETE", async () => {
    fetchMock.mockResolvedValue(ok());
    render(<AdPool pool={[card("01")]} published={[]} defaultCaption="" />);
    fireEvent.click(screen.getByRole("button", { name: /1\. reklam/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reklamı sil" }));
    expect(screen.getByRole("heading", { name: "Reklam silinsin mi?" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Kalıcı olarak sil" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/portal/ads/01", { method: "DELETE" }));
  });

  it("hata alan reklamda neden ve tekrar dene; sunucu hatası sayfada kalır", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Bu reklam tekrar denenecek durumda değil" }), { status: 409 })
    );
    render(
      <AdPool
        pool={[card("01", { state: "failed", publishError: "image download failed" })]}
        published={[]}
        defaultCaption=""
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /1\. reklam/ }));
    fireEvent.click(screen.getByRole("button", { name: "Tekrar dene" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/portal/ads/01/retry", { method: "POST" })
    );
    expect(await screen.findByText("Bu reklam tekrar denenecek durumda değil")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("yayınlananlar ayrı listede, Instagram linkiyle; metni varsayılansa varsayılan görünür", () => {
    render(
      <AdPool
        pool={[]}
        published={[
          card("09", { state: "published", igPermalink: "https://instagram.com/p/1/", publishedLabel: "25 Kas 21:00" }),
        ]}
        defaultCaption="Varsayılan metin"
      />
    );
    expect(screen.getByText("YAYINLANAN · 1")).toBeTruthy();
    expect(screen.getByText("Varsayılan metin")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Instagram'da aç" }).getAttribute("href")).toBe(
      "https://instagram.com/p/1/"
    );
  });
});

describe("withLocalNext — sıradaki rozeti yerel sıradan (V12c)", () => {
  const s = (id: string, state: AdCardView["state"]) => ({ id, state });
  it("ilk uygun kart sıradaki olur; hata ve yayınlanmakta olan korunur", () => {
    expect(
      withLocalNext([s("a", "failed"), s("b", "queued"), s("c", "next"), s("d", "publishing")]).map((c) => [
        c.id,
        c.state,
      ])
    ).toEqual([
      ["a", "failed"],
      ["b", "next"],
      ["c", "queued"],
      ["d", "publishing"],
    ]);
  });
});
