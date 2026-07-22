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

vi.mock("@/lib/scoped-db", () => ({
  getScopedDb: () => ({
    posts: { findManyWithRelations: vi.fn().mockResolvedValue([]) },
    clients: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));

import DashboardPage from "./page";

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
