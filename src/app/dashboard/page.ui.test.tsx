// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TokenAlertClient } from "@/lib/instagram-token";

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

/** Token uyarısı testleri bunu değiştirir; varsayılan: uyarı gerektiren müşteri yok. */
let tokenClients: TokenAlertClient[] = [];

vi.mock("@/lib/scoped-db", () => ({
  getScopedDb: () => ({
    posts: { findManyWithRelations: vi.fn().mockResolvedValue([]) },
    clients: {
      findMany: vi.fn().mockResolvedValue([]),
      withInstagramTokenExpiry: vi.fn(async () => tokenClients),
    },
  }),
}));

import DashboardPage from "./page";

beforeEach(() => {
  tokenClients = [];
});

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

describe("Dashboard boş durumu", () => {
  it("0 post varken boş durum mesajını gösterir", async () => {
    render(await DashboardPage());
    expect(screen.getByText("Henüz post yok. İlk postunu oluştur.")).toBeTruthy();
  });

  it("0 müşteri varken önce müşteri eklemeye yönlendirir", async () => {
    render(await DashboardPage());
    expect(screen.getByText(/Post oluşturmadan önce/)).toBeTruthy();
  });
});

describe("Dashboard Instagram token uyarısı", () => {
  it("token'ın süresine daha çok varsa uyarı göstermez", async () => {
    tokenClients = [
      {
        id: "c1",
        name: "Uzak Müşteri",
        instagramConnected: true,
        instagramTokenExpiry: daysFromNow(60),
      },
    ];
    render(await DashboardPage());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("son 10 güne girmiş müşteriyi adıyla uyarır", async () => {
    tokenClients = [
      {
        id: "c1",
        name: "Yakın Müşteri",
        instagramConnected: true,
        instagramTokenExpiry: daysFromNow(5),
      },
    ];
    render(await DashboardPage());
    expect(screen.getByRole("status").textContent).toContain("Yakın Müşteri");
  });

  it("süresi dolmuş müşteride yayının durduğunu söyler", async () => {
    tokenClients = [
      {
        id: "c1",
        name: "Dolmuş Müşteri",
        instagramConnected: true,
        instagramTokenExpiry: daysFromNow(-2),
      },
    ];
    render(await DashboardPage());
    expect(screen.getByRole("alert").textContent).toContain("Yayın şu an durmuş durumda");
  });
});
