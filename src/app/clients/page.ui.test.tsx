// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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

/** Sayfaya `getScopedDb` üzerinden dönecek müşteriler (ClientView şeklinde). */
let clients: unknown[] = [];

vi.mock("@/lib/scoped-db", () => ({
  getScopedDb: () => ({
    clients: { findMany: vi.fn(async () => clients) },
  }),
}));

import ClientsPage from "./page";

const clientView = (overrides: Record<string, unknown> = {}) => ({
  id: "client-1",
  agencyId: "agency-1",
  name: "Kahve Dükkanı",
  email: "kahve@ornek.com",
  createdAt: new Date("2026-01-01"),
  instagramUserId: null,
  instagramTokenExpiry: null,
  instagramConnected: false,
  instagramTokenHint: null,
  ...overrides,
});

describe("Clients boş durumu", () => {
  it("0 müşteri varken boş durum mesajını gösterir", async () => {
    clients = [];
    render(await ClientsPage());
    expect(
      screen.getByText("Henüz müşteri eklemedin. Post oluşturmadan önce bir müşteri ekle.")
    ).toBeTruthy();
  });
});

describe("Clients Instagram bağlama alanı", () => {
  it("Instagram bağlı olmayan müşteride bağlama düğmesini gösterir", async () => {
    clients = [clientView()];
    render(await ClientsPage());
    expect(screen.getByText("Instagram bağlı değil")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Instagram bağla" })).toBeTruthy();
  });

  it("bağlı müşteride yalnızca maskelenmiş token özeti çıkar", async () => {
    clients = [
      clientView({
        instagramUserId: "17841400000000000",
        instagramConnected: true,
        instagramTokenHint: "…oken",
        instagramTokenExpiry: new Date("2099-10-15"),
      }),
    ];
    const { container } = render(await ClientsPage());

    expect(screen.getByText("Instagram bağlı")).toBeTruthy();
    expect(container.textContent).toContain("…oken");
    // Sayfaya hiçbir token metni basılmaz — prop olarak da geçmez.
    expect(container.innerHTML).not.toContain("instagramAccessToken");
  });
});
