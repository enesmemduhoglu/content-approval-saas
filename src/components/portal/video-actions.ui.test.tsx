// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
  usePathname: () => "/portal/video/v1",
}));

import { UNDO_SECONDS, VideoActions, chipActive, toggleChip, type VideoActionsProps } from "./video-actions";

const props = (overrides: Partial<VideoActionsProps> = {}): VideoActionsProps => ({
  id: "v1",
  caption: "Caption",
  status: "approved",
  captionStatus: "ready",
  publishStatus: "idle",
  inQueue: false,
  requireApproval: true,
  canDelete: true,
  ...overrides,
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  replace.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VideoActions — kuyruk dışı video silme", () => {
  it("kuyruktan çıkarılan video: alt çubukta Sil + Kuyruğa geri al", () => {
    render(<VideoActions {...props()} />);
    expect(screen.getByRole("button", { name: "Sil" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kuyruğa geri al" })).toBeTruthy();
  });

  it("kuyruk dışındaki onay bekleyen videoda karar düğmeleri yok (önce kuyruğa alınır)", () => {
    render(<VideoActions {...props({ status: "pending" })} />);
    expect(screen.queryByRole("button", { name: "Onayla" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reddet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sil" })).toBeTruthy();
  });

  it("reddedilen video: Sil + Kuyruğa geri al; geri al iki seçenek sorar ve sona ekler", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "approved" }), { status: 200 }));
    render(<VideoActions {...props({ status: "rejected" })} />);
    expect(screen.getByRole("button", { name: "Sil" })).toBeTruthy();
    expect(screen.getByText("Kuyruğa geri alınca caption'ı düzenleyebilirsin.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Kuyruğa geri al" }));
    const dialog = screen.getByRole("dialog", { name: "Kuyruğa geri al" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Onaylayıp kuyruğa al/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/videos/v1/restore");
    expect(JSON.parse(init.body)).toEqual({ approve: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Onaylandı ve kuyruğa alındı")).toBeTruthy();
  });

  it("onay kapalıyken reddedilen video seçim sorulmadan geri alınır", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    render(<VideoActions {...props({ status: "rejected", requireApproval: false })} />);

    fireEvent.click(screen.getByRole("button", { name: "Kuyruğa geri al" }));

    await waitFor(() => expect(screen.getByText("Video kuyruğa geri alındı")).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ approve: false });
  });

  it("kuyruktaki videoda Sil yok", () => {
    render(<VideoActions {...props({ inQueue: true, canDelete: false })} />);
    expect(screen.queryByRole("button", { name: "Sil" })).toBeNull();
    expect(screen.getByRole("button", { name: "Kuyruktan çıkar" })).toBeTruthy();
  });

  it("Sil → onay → DELETE, sonra kuyruğa dönülür", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<VideoActions {...props()} />);

    fireEvent.click(screen.getByRole("button", { name: "Sil" }));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Video silinsin mi?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Kalıcı olarak sil" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/portal"));
    expect(fetchMock).toHaveBeenCalledWith("/api/portal/videos/v1", { method: "DELETE" });
  });

  it("silme hatası onay sayfasında kalır, sayfadan çıkılmaz", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Olmadı" }), { status: 500 }));
    render(<VideoActions {...props()} />);

    fireEvent.click(screen.getByRole("button", { name: "Sil" }));
    fireEvent.click(screen.getByRole("button", { name: "Kalıcı olarak sil" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Olmadı"));
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("VideoActions — redden hemen sonra 'Geri al'", () => {
  const queued = () => props({ status: "pending", inQueue: true, canDelete: false });

  async function rejectIt() {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "rejected", previousPosition: 7 }), { status: 200 })
    );
    render(<VideoActions {...queued()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reddet" }));
    fireEvent.change(screen.getByLabelText("Neden? (isteğe bağlı)"), { target: { value: "Yanlış" } });
    // Çubukta iki "Reddet" var (Vazgeç + Reddet); onaylayan sonuncusu.
    const buttons = screen.getAllByRole("button", { name: "Reddet" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(screen.getByText("Video reddedildi")).toBeTruthy());
  }

  it("red sonrası 'Geri al' görünür; basınca eski sıraya onay bekler hâlde döner", async () => {
    await rejectIt();
    expect(screen.queryByRole("button", { name: "Onayla" })).toBeNull();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    fireEvent.click(screen.getByRole("button", { name: "Geri al" }));

    await waitFor(() => expect(screen.getByText("Red geri alındı · video eski yerine döndü")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/portal/videos/v1/restore");
    expect(JSON.parse(init.body)).toEqual({ approve: false, position: 7 });
    expect(screen.queryByRole("button", { name: "Geri al" })).toBeNull();
  });

  it(`'Geri al' ${UNDO_SECONDS} sn sonra kalkar`, async () => {
    // Geri sayımın `setInterval`ı redde kuruluyor: sahte zaman ondan ÖNCE açık olmalı.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await rejectIt();
      expect(screen.getByRole("button", { name: "Geri al" })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(UNDO_SECONDS * 1000);
      });
      expect(screen.queryByRole("button", { name: "Geri al" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("VideoActions — onayla ve sıradakine geç", () => {
  const pending = (review?: VideoActionsProps["review"]) =>
    props({ status: "pending", inQueue: true, canDelete: false, review });
  const ok = () => new Response(JSON.stringify({ status: "approved" }), { status: 200 });

  it("birden fazla bekleyen varken çubuk kaçıncısında olduğunu söyler", () => {
    render(<VideoActions {...pending({ nextId: "v2", awaiting: 3, index: 1 })} />);
    expect(screen.getByText("Onay bekleyen 3 videodan 1.")).toBeTruthy();
  });

  it("onaydan sonra 'Onaylandı' + sıradaki bekleyen videonun linki", async () => {
    fetchMock.mockResolvedValue(ok());
    render(<VideoActions {...pending({ nextId: "v2", awaiting: 3, index: 1 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Onayla" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Onaylandı"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "approve" });
    const next = screen.getByRole("link", { name: /Sıradakine geç · 2 kaldı/ });
    expect(next.getAttribute("href")).toBe("/portal/video/v2");
    expect(screen.getByRole("link", { name: "Kuyruk" }).getAttribute("href")).toBe("/portal");
    // Karar düğmeleri gitti (sayfa tazelenmeden de).
    expect(screen.queryByRole("button", { name: "Onayla" })).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("başka bekleyen yoksa tek düğme: Kuyruğa dön", async () => {
    fetchMock.mockResolvedValue(ok());
    render(<VideoActions {...pending({ nextId: null, awaiting: 1, index: 1 })} />);
    expect(screen.queryByText(/Onay bekleyen 1 videodan/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Onayla" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("başka video yok"));
    expect(screen.getByRole("link", { name: "Kuyruğa dön" }).getAttribute("href")).toBe("/portal");
    expect(screen.queryByRole("link", { name: /Sıradakine geç/ })).toBeNull();
  });

  it("onay kapalıyken (review yok) eski mesaj", async () => {
    fetchMock.mockResolvedValue(ok());
    render(<VideoActions {...pending()} />);
    fireEvent.click(screen.getByRole("button", { name: "Onayla" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("sırası gelince yayınlanacak"));
    expect(screen.queryByRole("link", { name: /Sıradakine geç/ })).toBeNull();
  });

  it("onay başarısızsa sıradakine geçiş çıkmaz, hata görünür", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Video artık onay beklemiyor" }), { status: 409 }));
    render(<VideoActions {...pending({ nextId: "v2", awaiting: 2, index: 1 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Onayla" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Video artık onay beklemiyor"));
    expect(screen.queryByRole("link", { name: /Sıradakine geç/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Onayla" })).toBeTruthy();
  });
});

describe("VideoActions — yayın hatası", () => {
  it("tekrar denemek boşunaysa 'Tekrar dene'nin üstünde uyarı", () => {
    render(
      <VideoActions
        {...props({ inQueue: true, canDelete: false, publishStatus: "failed", retryNote: "Aynı dosyayla boşuna." })}
      />
    );
    expect(screen.getByText("Aynı dosyayla boşuna.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tekrar dene" })).toBeTruthy();
  });
});

describe("Yeniden üret — not çipleri", () => {
  it("toggleChip: ekler, ikinci basışta çıkarır; elle yazılanı korur", () => {
    expect(toggleChip("", "Daha kısa")).toBe("daha kısa");
    expect(toggleChip("daha kısa", "Emoji yok")).toBe("daha kısa, emoji yok");
    expect(toggleChip("daha kısa, emoji yok", "Daha kısa")).toBe("emoji yok");
    expect(toggleChip("kancayı soruyla aç", "Daha kısa")).toBe("kancayı soruyla aç, daha kısa");
    // Büyük/küçük harf ve boşluk farkı aynı parça sayılır (Türkçe İ/ı dahil).
    expect(chipActive("  DAHA KISA ,x", "Daha kısa")).toBe(true);
    expect(chipActive("kanca daha güçlü", "Kanca daha güçlü")).toBe(true);
  });

  it("çipe basınca not alanı dolar; gönderilen not çiplerden oluşur", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<VideoActions {...props({ status: "pending", inQueue: true, canDelete: false })} />);
    fireEvent.click(screen.getByRole("button", { name: "Daha kısa" }));
    fireEvent.click(screen.getByRole("button", { name: "Emoji yok" }));
    expect((screen.getByRole("textbox", { name: "Yeniden üret" }) as HTMLInputElement).value).toBe("daha kısa, emoji yok");
    expect(screen.getByRole("button", { name: "Daha kısa" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Yeniden üret" }));
    fireEvent.click(screen.getByRole("button", { name: "Evet, yeniden üret" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/videos/v1/regenerate");
    expect(JSON.parse(init.body)).toEqual({ note: "daha kısa, emoji yok" });
  });
});
