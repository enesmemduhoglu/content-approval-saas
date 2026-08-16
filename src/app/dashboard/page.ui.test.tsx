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
/** Rozet testleri bunu değiştirir; varsayılan: post yok. */
let posts: unknown[] = [];

vi.mock("@/lib/scoped-db", () => ({
  getScopedDb: () => ({
    posts: { findManyWithRelations: vi.fn(async () => posts) },
    clients: {
      findMany: vi.fn().mockResolvedValue([]),
      withInstagramTokenExpiry: vi.fn(async () => tokenClients),
    },
  }),
}));

import DashboardPage from "./page";

beforeEach(() => {
  tokenClients = [];
  posts = [];
});

/**
 * `findManyWithRelations`'ın döndürdüğü şekle sadık post kaydı: `client`
 * üzerinde ham Instagram alanları DEĞİL, türetilmiş `publishTarget` bulunur.
 */
function postKaydi(overrides: {
  status: string;
  publishStatus: string;
  publishTarget: boolean;
}) {
  return {
    id: "p1",
    caption: "Test postu",
    createdAt: new Date(),
    igPermalink: null,
    approvalLink: null,
    images: [{ id: "i1", url: "https://example.com/1.jpg", altText: null }],
    ...overrides,
    client: { id: "c1", name: "Müşteri", email: "m@example.com", publishTarget: overrides.publishTarget },
  };
}

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

describe("Dashboard 'yayınlanmadı' rozeti", () => {
  it("onaylanmış + yayın hedefli + idle postu 'Yayınlanmadı' diye işaretler", async () => {
    posts = [postKaydi({ status: "approved", publishStatus: "idle", publishTarget: true })];
    render(await DashboardPage());
    expect(screen.getByText("Yayınlanmadı")).toBeTruthy();
  });

  it("Instagram bağlı olmayan müşteride idle post sessiz kalır", async () => {
    posts = [postKaydi({ status: "approved", publishStatus: "idle", publishTarget: false })];
    render(await DashboardPage());
    expect(screen.queryByText("Yayınlanmadı")).toBeNull();
  });

  it("henüz onaylanmamış postta rozet çıkmaz", async () => {
    posts = [postKaydi({ status: "pending", publishStatus: "idle", publishTarget: true })];
    render(await DashboardPage());
    expect(screen.queryByText("Yayınlanmadı")).toBeNull();
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
