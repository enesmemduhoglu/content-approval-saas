import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V7a — portal layout'unun iOS meta'sı ve viewport'u. iOS "Ana Ekrana Ekle"
 * manifest'i değil bu etiketleri okuyor; adı/ikonu müşteriye göre gelmeli.
 * Oturum `next/headers`'tan okunduğu için çerez okuyucu sahteleniyor.
 */
let cookieValue: string | undefined;
/** K29 — giriş ekranı iz çerezi; oturum yokken ad/ikonu o belirler. */
let traceValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value =
        name === "cas_portal" ? cookieValue : name === "cas_portal_kimlik" ? traceValue : undefined;
      return value ? { name, value } : undefined;
    },
  }),
}));

// `next/font` derleme zamanı yükleyicisi (SWC dönüştürür); vitest'te çağrılabilir
// bir fonksiyon değil. Testin konusu meta/viewport, font sınıfları değil.
vi.mock("./fonts", () => ({
  archivo: { variable: "archivo" },
  figtree: { variable: "figtree" },
}));

import { db } from "@/lib/db";
import { signClientSession, signPortalTrace } from "@/lib/client-auth";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser } from "@tests/helpers/portal";
import { generateMetadata, generateViewport } from "./layout";

let user: { id: string; clientId: string };

beforeEach(async () => {
  await resetDb();
  cookieValue = undefined;
  traceValue = undefined;
  const agency = await createAgency();
  const client = await createClient(agency.id);
  await db.client.update({
    where: { id: client.id },
    data: {
      appName: "Furkan Teacher",
      appShortName: "Furkan",
      appThemeColor: "#1e3a34",
      appIconBase: "/icons/furkan-teacher",
    },
  });
  user = await createClientUser(client.id);
});

describe("portal layout — iOS meta ve viewport", () => {
  it("oturumlu: apple başlığı ve 180 px ikon müşteriye ait", async () => {
    cookieValue = signClientSession({ clientUserId: user.id, clientId: user.clientId }).value;
    const meta = await generateMetadata();
    expect(meta.appleWebApp).toMatchObject({
      capable: true,
      title: "Furkan",
      statusBarStyle: "default",
    });
    expect(meta.icons).toMatchObject({ apple: "/icons/furkan-teacher/icon-180.png" });
    // Manifest linki metadata'dan DEĞİL layout'tan (use-credentials) geliyor.
    expect(meta.manifest).toBeUndefined();
  });

  it("oturumsuz: nötr ad ve varsayılan ikon", async () => {
    const meta = await generateMetadata();
    expect(meta.appleWebApp).toMatchObject({ title: "Kuyruk" });
    expect(meta.icons).toMatchObject({ apple: "/icons/varsayilan/icon-180.png" });
  });

  it("viewport: cover + müşterinin tema rengi", async () => {
    cookieValue = signClientSession({ clientUserId: user.id, clientId: user.clientId }).value;
    expect(await generateViewport()).toEqual({
      width: "device-width",
      initialScale: 1,
      viewportFit: "cover",
      themeColor: "#1e3a34",
    });
  });
});

describe("portal layout — oturum yokken iz çerezi (K29)", () => {
  it("izli: apple başlığı, 180 px ikon ve tema rengi son giriş yapılan müşteriden", async () => {
    traceValue = signPortalTrace(user.clientId).value;
    const meta = await generateMetadata();
    expect(meta.appleWebApp).toMatchObject({ title: "Furkan" });
    expect(meta.icons).toMatchObject({ apple: "/icons/furkan-teacher/icon-180.png" });
    expect((await generateViewport()).themeColor).toBe("#1e3a34");
  });

  it("imzası tutmayan iz: varsayılan", async () => {
    traceValue = `${signPortalTrace(user.clientId).value}x`;
    const meta = await generateMetadata();
    expect(meta.appleWebApp).toMatchObject({ title: "Kuyruk" });
    expect(meta.icons).toMatchObject({ apple: "/icons/varsayilan/icon-180.png" });
  });
});
