// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * K29 — giriş ekranı, oturum yokken bu cihazda son giriş yapılan müşterinin
 * adını ve ikonunu gösteriyor. Zincirin tamamı gerçek: `next/headers`'tan
 * okunan imzalı iz → doğrulama → kimlik çözümü → çizim. Sahte olan yalnızca
 * veritabanı (UI testleri Postgres'e bağlanmıyor).
 */
let traceValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "cas_portal_kimlik" && traceValue ? { name, value: traceValue } : undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/email-portal", () => ({ sendPortalLoginEmail: vi.fn() }));

const CLIENT_ID = "musteri-furkan";
const findApp = vi.fn(async (clientId: string) =>
  clientId === CLIENT_ID
    ? {
        name: "Furkan Teacher Teaching",
        appName: "Furkan Teacher",
        appShortName: "Furkan",
        appThemeColor: "#1e3a34",
        appIconBase: "/icons/furkan-teacher",
      }
    : null
);
vi.mock("@/lib/client-scoped-db", () => ({
  findClientAppForLoginScreen: (clientId: string) => findApp(clientId),
  getClientScopedDb: () => {
    throw new Error("oturumsuz giriş sayfası kapsamlı veri katmanına gitmemeli");
  },
}));

import { signPortalTrace } from "@/lib/client-auth";
import PortalLoginPage from "./page";

beforeEach(() => {
  traceValue = undefined;
  findApp.mockClear();
});

afterEach(() => cleanup());

function icon(): HTMLImageElement {
  return document.querySelector(".p-login-icon") as HTMLImageElement;
}

describe("/portal/giris — giriş ekranı kimliği", () => {
  it("izli: son giriş yapılan müşterinin adı ve ikonu", async () => {
    traceValue = signPortalTrace(CLIENT_ID).value;
    render(await PortalLoginPage());
    expect(screen.getByText("FURKAN TEACHER")).toBeTruthy();
    expect(icon().getAttribute("src")).toBe("/icons/furkan-teacher/icon-192.png");
    expect(screen.queryByText("VİDEO KUYRUĞU")).toBeNull();
    expect(findApp).toHaveBeenCalledWith(CLIENT_ID);
  });

  it("izsiz: nötr varsayılan", async () => {
    render(await PortalLoginPage());
    expect(screen.getByText("VİDEO KUYRUĞU")).toBeTruthy();
    expect(icon().getAttribute("src")).toBe("/icons/varsayilan/icon-192.png");
    expect(findApp).not.toHaveBeenCalled();
  });

  it("imzası tutmayan iz: varsayılan, veritabanına hiç gidilmez", async () => {
    traceValue = CLIENT_ID;
    render(await PortalLoginPage());
    expect(screen.getByText("VİDEO KUYRUĞU")).toBeTruthy();
    expect(findApp).not.toHaveBeenCalled();
  });

  it("iz çözülemiyorsa (müşteri silinmiş): varsayılan", async () => {
    traceValue = signPortalTrace("silinmis-musteri").value;
    render(await PortalLoginPage());
    expect(screen.getByText("VİDEO KUYRUĞU")).toBeTruthy();
  });

  it("giriş ekranında e-posta ya da kişisel bilgi yok — yalnızca ad", async () => {
    traceValue = signPortalTrace(CLIENT_ID).value;
    const { container } = render(await PortalLoginPage());
    expect(container.textContent).not.toContain("@");
    // E-posta alanı boş gelir; iz adresi önceden doldurmaz.
    const email = container.querySelector('input[type="email"]') as HTMLInputElement | null;
    expect(email?.value ?? "").toBe("");
  });
});
