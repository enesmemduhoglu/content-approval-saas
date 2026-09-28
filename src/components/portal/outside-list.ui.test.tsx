// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/portal",
}));

import { OutsideList, TOAST_MS, type OutsideCard } from "./outside-list";

const card = (id: string, overrides: Partial<OutsideCard> = {}): OutsideCard => ({
  id,
  caption: `Caption ${id}`,
  status: "pending",
  captionStatus: "ready",
  publishStatus: "idle",
  coverUrl: null,
  rejectionReason: null,
  deleteLabel: null,
  deleteSoon: false,
  ...overrides,
});

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

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

function listed(): string[] {
  const list = screen.queryByRole("list", { name: "Kuyruk dışı videolar" });
  if (!list) return [];
  return within(list)
    .getAllByRole("link")
    .map((a) => a.getAttribute("href")?.split("/").pop() ?? "");
}

describe("OutsideList", () => {
  it("her kartta detay linki ve silme düğmesi var; reddedilen de silinebilir", () => {
    render(<OutsideList cards={[card("a"), card("b", { status: "rejected" })]} requireApproval />);
    expect(listed()).toEqual(["a", "b"]);
    expect(screen.getAllByRole("button", { name: "Videoyu sil" })).toHaveLength(2);
    expect(screen.getByText("Reddedildi")).toBeTruthy();
  });

  it("çöp kutusu tek dokunuşta silmez: onay sayfası açılır, Vazgeç kapatır", () => {
    render(<OutsideList cards={[card("a")]} requireApproval />);
    fireEvent.click(screen.getByRole("button", { name: "Videoyu sil" }));

    const dialog = screen.getByRole("dialog", { name: "Video silinsin mi?" });
    expect(within(dialog).getByText("Caption a")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Vazgeç" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(listed()).toEqual(["a"]);
  });

  it("Escape onay sayfasını kapatır", () => {
    render(<OutsideList cards={[card("a")]} requireApproval />);
    fireEvent.click(screen.getByRole("button", { name: "Videoyu sil" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("onaylayınca DELETE atar, kart düşer, 'Video silindi' ve sayfa tazelenir", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<OutsideList cards={[card("a"), card("b")]} requireApproval />);

    fireEvent.click(screen.getAllByRole("button", { name: "Videoyu sil" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Kalıcı olarak sil" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Video silindi"));
    expect(fetchMock).toHaveBeenCalledWith("/api/portal/videos/a", { method: "DELETE" });
    expect(listed()).toEqual(["b"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("404 (başka sekmede silinmiş) de başarı sayılır; son kart gidince bölüm kalkar, bildirim kalır", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Video bulunamadı" }), { status: 404 }));
    const { rerender } = render(<OutsideList cards={[card("a")]} requireApproval />);

    fireEvent.click(screen.getByRole("button", { name: "Videoyu sil" }));
    fireEvent.click(screen.getByRole("button", { name: "Kalıcı olarak sil" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Video silindi"));
    expect(screen.queryByRole("heading", { name: "Kuyruk dışı" })).toBeNull();
    // router.refresh sonrası sunucu boş liste gönderir: bileşen yerinde kalır,
    // bildirim de (eskiden bölüm sayfada koşullu çizildiği için bildirim de gidiyordu).
    rerender(<OutsideList cards={[]} requireApproval />);
    expect(screen.getByRole("status").textContent).toContain("Video silindi");
  });

  it("bildirim birkaç saniye sonra kendiliğinden kalkar", async () => {
    // `waitFor` sahte setTimeout'la donar; sahte zamanda mikro görevler elle boşaltılır.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      render(<OutsideList cards={[card("a"), card("b")]} requireApproval />);
      fireEvent.click(screen.getAllByRole("button", { name: "Videoyu sil" })[0]);
      fireEvent.click(screen.getByRole("button", { name: "Kalıcı olarak sil" }));
      for (let i = 0; i < 20 && !screen.queryByRole("status"); i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(screen.getByRole("status").textContent).toContain("Video silindi");
      act(() => {
        vi.advanceTimersByTime(TOAST_MS - 1);
      });
      expect(screen.queryByRole("status")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("kart yoksa hiçbir şey çizilmez (bölüm başlığı dahil)", () => {
    const { container } = render(<OutsideList cards={[]} requireApproval />);
    expect(container.innerHTML).toBe("");
  });

  it("409'da kart kalır, hata onay sayfasında görünür", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Yalnızca kuyruk dışındaki videolar silinebilir" }), {
        status: 409,
      })
    );
    render(<OutsideList cards={[card("a")]} requireApproval />);

    fireEvent.click(screen.getByRole("button", { name: "Videoyu sil" }));
    fireEvent.click(screen.getByRole("button", { name: "Kalıcı olarak sil" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Yalnızca kuyruk dışındaki videolar silinebilir")
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(listed()).toEqual(["a"]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("çıkarılan video: geri al doğrudan sona alır (to-end), kart düşer", async () => {
    fetchMock.mockResolvedValue(ok());
    render(<OutsideList cards={[card("a"), card("b")]} requireApproval />);

    fireEvent.click(screen.getAllByRole("button", { name: "Kuyruğa geri al" })[0]);

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Kuyruğa geri alındı"));
    expect(fetchMock).toHaveBeenCalledWith("/api/portal/videos/a/to-end", expect.objectContaining({ method: "POST" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(listed()).toEqual(["b"]);
    expect(refresh).toHaveBeenCalled();
  });

  it("silme sayacı kartın altında; yalnızca sayacı olan kartta (V9)", () => {
    render(
      <OutsideList
        cards={[
          card("a", { status: "rejected", deleteLabel: "3 gün sonra silinecek" }),
          card("b", { deleteLabel: "Yarın silinecek", deleteSoon: true }),
          card("c"),
        ]}
        requireApproval
      />
    );
    expect(screen.getByText("3 gün sonra silinecek").className).toBe("p-expiry");
    expect(screen.getByText("Yarın silinecek").className).toContain("p-expiry--soon");
    expect(document.querySelectorAll(".p-expiry")).toHaveLength(2);
    expect(screen.getByText(/3 gün sonra kendiliğinden silinir/)).toBeTruthy();
  });

  it("reddedilen video: red nedeni kartta; geri al iki seçenekli sayfayı açar", async () => {
    fetchMock.mockResolvedValue(ok());
    render(
      <OutsideList cards={[card("r", { status: "rejected", rejectionReason: "Ses kötü" })]} requireApproval />
    );
    expect(screen.getByText("Neden: Ses kötü")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Kuyruğa geri al" }));
    const dialog = screen.getByRole("dialog", { name: "Kuyruğa geri al" });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /Onaylayıp kuyruğa al/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Onaylandı ve kuyruğa alındı"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/videos/r/restore");
    expect(JSON.parse(init.body)).toEqual({ approve: true });
    expect(listed()).toEqual([]);
  });

  it("reddedilen video, caption hazır değil: 'Onaylayıp al' kapalı, onay bekleyen olarak alınabilir", async () => {
    fetchMock.mockResolvedValue(ok());
    render(<OutsideList cards={[card("r", { status: "rejected", captionStatus: "failed" })]} requireApproval />);

    fireEvent.click(screen.getByRole("button", { name: "Kuyruğa geri al" }));
    const dialog = screen.getByRole("dialog");
    expect(
      (within(dialog).getByRole("button", { name: /Onaylayıp kuyruğa al/ }) as HTMLButtonElement).disabled
    ).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: /Onay bekleyen olarak al/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("onayını bekliyor"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ approve: false });
  });

  it("onay kapalıyken reddedilen video seçim sorulmadan geri alınır", async () => {
    fetchMock.mockResolvedValue(ok());
    render(<OutsideList cards={[card("r", { status: "rejected" })]} requireApproval={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Kuyruğa geri al" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Kuyruğa geri alındı"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ approve: false });
  });

  it("geri alma hatası seçim sayfasında görünür, kart kalır", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Bu video reddedilmiş değil" }), { status: 409 })
    );
    render(<OutsideList cards={[card("r", { status: "rejected" })]} requireApproval />);

    fireEvent.click(screen.getByRole("button", { name: "Kuyruğa geri al" }));
    fireEvent.click(screen.getByRole("button", { name: /Onay bekleyen olarak al/ }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Bu video reddedilmiş değil"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(listed()).toEqual(["r"]);
  });

  it("kapak yoksa yer tutucu, varsa görsel çizilir", () => {
    const { container } = render(
      <OutsideList cards={[card("a"), card("b", { coverUrl: "https://r2/b.jpg" })]} requireApproval />
    );
    expect(container.querySelectorAll(".p-cover--empty")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://r2/b.jpg");
  });
});
