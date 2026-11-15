import { beforeEach, describe, expect, it, vi } from "vitest";

// `redirect` gerçekte throw eder; testte hedefi taşıyan bir hata atıp yakalıyoruz.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import HomePage from "./page";

const authMock = auth as unknown as ReturnType<typeof vi.fn>;

describe("kök sayfa", () => {
  beforeEach(() => authMock.mockReset());

  it("oturumsuz ziyaretçi portala gider — ajans Google girişine DEĞİL", async () => {
    // Regresyon: kök eskiden ajans girişiydi; müşteri Google'la girip kendine
    // boş bir ajans açıyordu (2026-11-15).
    authMock.mockResolvedValue(null);
    await expect(HomePage()).rejects.toThrow("REDIRECT:/portal");
  });

  it("ajans oturumu varsa panele gider", async () => {
    authMock.mockResolvedValue({ agencyId: "a1" });
    await expect(HomePage()).rejects.toThrow("REDIRECT:/dashboard");
  });
});
