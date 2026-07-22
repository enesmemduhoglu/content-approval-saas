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
    clients: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));

import ClientsPage from "./page";

describe("Clients boş durumu", () => {
  it("0 müşteri varken boş durum mesajını gösterir", async () => {
    render(await ClientsPage());
    expect(
      screen.getByText("Henüz müşteri eklemedin. Post oluşturmadan önce bir müşteri ekle.")
    ).toBeTruthy();
  });
});
