// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirect(...args),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));

const resolveInviteView = vi.fn();
vi.mock("@/lib/membership", () => ({
  resolveInviteView: (...args: unknown[]) => resolveInviteView(...args),
}));

import InvitePage from "./page";

/**
 * Durum makinesinin KENDİSİ membership.test.ts'te sınanıyor; burada sınanan
 * tek şey sayfanın her dalı doğru yazıya ve doğru düğmeye çevirdiği.
 */
async function renderPage(view: unknown, session: unknown = null) {
  authMock.mockResolvedValue(session);
  resolveInviteView.mockResolvedValue(view);
  render(await InvitePage({ params: Promise.resolve({ token: "tok123" }) }));
}

describe("/invite/[token]", () => {
  it("geçersiz token: yeni davet iste", async () => {
    await renderPage({ kind: "not_found" });
    expect(screen.getByText(/geçersiz/i)).toBeTruthy();
  });

  it("kullanılmış davet", async () => {
    await renderPage({ kind: "used" });
    expect(screen.getByText(/zaten kullanılmış/i)).toBeTruthy();
  });

  it("süresi dolmuş davet ajans adını söyler", async () => {
    await renderPage({ kind: "expired", agencyName: "Asıl Ajans" });
    expect(screen.getByText(/süresi doldu/i)).toBeTruthy();
    expect(screen.getByText("Asıl Ajans")).toBeTruthy();
  });

  it("girişsiz: e-posta MASKELİ ve giriş linki bu sayfaya döner", async () => {
    await renderPage({
      kind: "anonymous",
      agencyName: "Asıl Ajans",
      email: "eneshan034@gmail.com",
      role: "member",
      invitedByEmail: "sahip@ornek.com",
    });
    // Tam adres sızmamalı; maskeli hâli görünmeli.
    expect(screen.queryByText("eneshan034@gmail.com")).toBeNull();
    expect(screen.getByText(/en•+@gmail\.com/)).toBeTruthy();

    const link = screen.getByText(/Google ile giriş yap/i).closest("a");
    expect(link?.getAttribute("href")).toBe(
      "/api/auth/signin?callbackUrl=%2Finvite%2Ftok123"
    );
  });

  it("yanlış hesap: çıkış düğmesi çıkar, devir düğmesi ÇIKMAZ", async () => {
    await renderPage({
      kind: "wrong_account",
      agencyName: "Asıl Ajans",
      email: "davetli@ornek.com",
      signedInAs: "baskasi@ornek.com",
    });
    // Tam eşleşme: gövde metninde de "Çıkış yapıp…" geçiyor, aranan DÜĞME.
    expect(screen.getByText("Çıkış yap").getAttribute("href")).toBe("/api/auth/signout");
    expect(screen.queryByText(/Kabul et ve ekibe geç/i)).toBeNull();
  });

  it("zaten üye: panele yönlendirir", async () => {
    redirect.mockClear();
    await renderPage({ kind: "already_member" });
    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("devir: ne kaybedeceğini yazar ve kabul düğmesi çıkar", async () => {
    await renderPage({
      kind: "transfer",
      agencyName: "Asıl Ajans",
      role: "member",
      invitedByEmail: "sahip@ornek.com",
      currentAgencyName: "Boş Kabuk",
      currentAgencyEmpty: true,
      blocked: false,
    });
    expect(screen.getByText(/Kabul et ve ekibe geç/i)).toBeTruthy();
    expect(screen.getByText(/kaybedeceğin bir şey yok/i)).toBeTruthy();
  });

  it("devir + dolu eski ajans: kaybın ne olduğu AÇIKÇA yazılır", async () => {
    await renderPage({
      kind: "transfer",
      agencyName: "Asıl Ajans",
      role: "owner",
      invitedByEmail: null,
      currentAgencyName: "Dolu Ajans",
      currentAgencyEmpty: false,
      blocked: false,
    });
    expect(screen.getByText(/artık onları göremezsin/i)).toBeTruthy();
  });

  it("blocked: düğme YOK, sebep ve çıkış yolu yazılı", async () => {
    await renderPage({
      kind: "transfer",
      agencyName: "Asıl Ajans",
      role: "member",
      invitedByEmail: null,
      currentAgencyName: "Dolu Ajans",
      currentAgencyEmpty: false,
      blocked: true,
    });
    expect(screen.queryByText(/Kabul et ve ekibe geç/i)).toBeNull();
    expect(screen.getByText(/TEK/)).toBeTruthy();
    expect(screen.getByText(/Ekip ayarlarına git/i)).toBeTruthy();
  });
});
