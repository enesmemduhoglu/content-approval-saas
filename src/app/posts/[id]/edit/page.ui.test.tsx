// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ agencyId: "agency-1", agencyName: "Test Ajansı" }),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

/** Her test bunu kurar; `null` = post bulunamadı. */
let post: unknown = null;

vi.mock("@/lib/scoped-db", () => ({
  getScopedDb: () => ({
    posts: { findByIdForRevision: vi.fn(async () => post) },
  }),
}));

import EditPostPage from "./page";

function postKaydi(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    caption: "Eski metin",
    status: "revision_requested",
    publishStatus: "idle",
    revisionRound: 1,
    client: { id: "c1", name: "Müşteri" },
    images: [{ id: "i1", url: "https://example.com/1.jpg" }],
    revisions: [
      {
        id: "r1",
        round: 1,
        actor: "client",
        event: "revision_requested",
        message: "İkinci görseli değiştirelim",
        caption: "Eski metin",
        createdAt: new Date(),
      },
    ],
    ...overrides,
  };
}

function render_(id = "p1") {
  return EditPostPage({ params: Promise.resolve({ id }) });
}

beforeEach(() => {
  post = postKaydi();
});

describe("Post düzenleme sayfası", () => {
  it("revizyonda müşterinin isteğini, mevcut görseli ve metni bir arada gösterir", async () => {
    render(await render_());

    // İki yerde: formun üstündeki açık istek + katlı revizyon zinciri.
    expect(screen.getAllByText(/İkinci görseli değiştirelim/).length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: "Mevcut görsel 1/1" })).toBeTruthy();
    // Metin kutusu MEVCUT metinle dolu gelir: revizyon sıfırdan yazmak değil,
    // var olanı düzeltmek.
    expect(screen.getByLabelText("Post metni").textContent).toBe("Eski metin");
    expect(screen.getByRole("button", { name: "Onaya geri gönder" })).toBeTruthy();
  });

  it("görsel değiştirme dosya alanı açılabiliyor — turun asıl derdi bu", async () => {
    render(await render_());
    // Alan katlı başlar; açılmadıkça mevcut görsellere dokunulmadığı görünsün.
    expect(screen.queryByLabelText(/Yeni görseller/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Görselleri değiştir" }));
    const input = screen.getByLabelText(/Yeni görseller/) as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
  });

  it("onay bekleyen postta SESSİZ düzeltme modu açılır", async () => {
    post = postKaydi({ status: "pending", revisions: [] });
    render(await render_());

    // Aynı form, farklı sonuç: mail attırmayan bir kaydetme.
    expect(screen.getByRole("button", { name: "Kaydet" })).toBeTruthy();
    expect(screen.getByText(/müşteriye mail attırmaz/)).toBeTruthy();
    // Not alanı yalnızca revizyonda anlamlı — sessiz düzeltmede kimseye gitmez.
    expect(screen.queryByLabelText("Müşteriye not")).toBeNull();
    expect(screen.getByLabelText("Post metni")).toBeTruthy();
  });

  it("karar verilmiş postta form hiç çizilmez", async () => {
    post = postKaydi({ status: "approved" });
    render(await render_());

    expect(screen.getByText("Bu post düzenlenemez")).toBeTruthy();
    expect(screen.queryByLabelText("Post metni")).toBeNull();
  });

  it("yayınlanmış postta form yerine gerekçe çıkar", async () => {
    post = postKaydi({ publishStatus: "published" });
    render(await render_());

    expect(screen.getByText("Yayınlanmış post düzenlenemez")).toBeTruthy();
    expect(screen.queryByLabelText("Post metni")).toBeNull();
  });

  it("başka ajansın postu bulunamadı olarak döner (IDOR)", async () => {
    post = null;
    render(await render_("baskasinin-postu"));

    expect(screen.getByText("Bu post bulunamadı")).toBeTruthy();
  });
});
