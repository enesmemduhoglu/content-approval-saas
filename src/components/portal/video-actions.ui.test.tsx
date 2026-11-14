// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
  usePathname: () => "/portal/video/v1",
}));

import { VideoActions, chipActive, toggleChip, type VideoActionsProps } from "./video-actions";

const props = (overrides: Partial<VideoActionsProps> = {}): VideoActionsProps => ({
  id: "v1",
  caption: "Caption",
  status: "approved",
  captionStatus: "ready",
  publishStatus: "idle",
  inQueue: false,
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

  it("kuyruk dışındaki bekleyen videoda Onayla/Reddet yok, Sil var", () => {
    render(<VideoActions {...props({ status: "pending" })} />);
    expect(screen.queryByRole("button", { name: "Onayla" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reddet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sil" })).toBeTruthy();
  });

  it("reddedilen (K33 öncesi) video: Sil + Kuyruğa geri al; seçim sorulmadan /restore'a gider", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    render(<VideoActions {...props({ status: "rejected" })} />);
    expect(screen.getByRole("button", { name: "Sil" })).toBeTruthy();
    expect(screen.getByText("Kuyruğa geri alınca caption'ı düzenleyebilirsin.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Kuyruğa geri al" }));

    await waitFor(() => expect(screen.getByText("Video kuyruğa geri alındı")).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/videos/v1/restore");
    expect(JSON.parse(init.body)).toEqual({});
    expect(refresh).toHaveBeenCalled();
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

describe("VideoActions — K33: onay/red yok", () => {
  it.each(["pending", "approved"] as const)(
    "kuyruktaki %s videoda Onayla/Reddet yok, alt çubuk da yok; caption düzenlenebilir",
    (status) => {
      const { container } = render(
        <VideoActions {...props({ status, inQueue: true, canDelete: false })} />
      );
      expect(screen.queryByRole("button", { name: "Onayla" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reddet" })).toBeNull();
      expect(container.querySelector(".p-actionbar")).toBeNull();
      expect((screen.getByLabelText("Caption") as HTMLTextAreaElement).disabled).toBe(false);
    }
  );

  it("caption hazırken sırası gelince bu hâliyle yayınlanacağını söyler", () => {
    render(<VideoActions {...props({ status: "pending", inQueue: true, canDelete: false })} />);
    expect(screen.getByText(/sırası gelince bu hâliyle yayınlanır/)).toBeTruthy();
  });

  it("onaylı videoda yeniden üretme uyarısı 'yeniden onay' demez", () => {
    render(<VideoActions {...props({ status: "approved", inQueue: true, canDelete: false })} />);
    fireEvent.click(screen.getByRole("button", { name: "Yeniden üret" }));
    const dialog = screen.getByRole("alertdialog", { name: "Yeniden üretme onayı" });
    expect(dialog.textContent).not.toMatch(/onayını bekleyecek/);
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

describe("Yeniden üret — takılı caption", () => {
  const queued = (overrides: Partial<VideoActionsProps> = {}) =>
    props({ status: "pending", inQueue: true, canDelete: false, caption: "", ...overrides });

  it("taze pending: 'hazırlanıyor' yazar, düğme YOK (iş yolda, ikinci iş açılmasın)", () => {
    render(<VideoActions {...queued({ captionStatus: "pending" })} />);
    expect(screen.getByText(/Caption hazırlanıyor/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yeniden üret" })).toBeNull();
  });

  it("generating: captionStuck gelse bile düğme YOK — sunucu generating'i kabul etmiyor", () => {
    render(<VideoActions {...queued({ captionStatus: "generating", captionStuck: true })} />);
    expect(screen.getByText(/Caption hazırlanıyor/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yeniden üret" })).toBeNull();
  });

  it("takılı pending: uyarı + düğme; onay metni elle düzenlemeden söz etmez, istek gider", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, captionQueued: true }), { status: 200 }));
    render(<VideoActions {...queued({ captionStatus: "pending", captionStuck: true })} />);
    expect(screen.queryByText(/Caption hazırlanıyor/)).toBeNull();
    expect(screen.getByText(/beklenenden uzun sürdü/)).toBeTruthy();
    // Düzenlenecek caption yok: boş kilitli alan gösterilmez.
    expect(screen.queryByRole("textbox", { name: /caption/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Yeniden üret" }));
    const dialog = screen.getByRole("alertdialog", { name: "Yeniden üretme onayı" });
    expect(dialog.textContent).toContain("yeniden başlatılacak");
    expect(dialog.textContent).not.toContain("elle yaptığın");
    fireEvent.click(within(dialog).getByRole("button", { name: "Evet, yeniden üret" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/portal/videos/v1/regenerate");
  });

  it("takılı ama yayında kilitli (publishing): düğme YOK — sunucu da reddeder", () => {
    render(<VideoActions {...queued({ captionStatus: "pending", captionStuck: true, publishStatus: "publishing" })} />);
    expect(screen.queryByRole("button", { name: "Yeniden üret" })).toBeNull();
  });
});
