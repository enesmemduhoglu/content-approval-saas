import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resolvePortalApp, DEFAULT_PORTAL_APP } from "@/lib/portal-app";
import {
  CLIENT_SESSION_COOKIE,
  CLIENT_TRACE_COOKIE,
  signClientSession,
  signPortalTrace,
} from "@/lib/client-auth";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import {
  createClientUser,
  portalCookie,
  portalRequest,
  portalTraceCookie,
} from "@tests/helpers/portal";
import { GET } from "./route";

/** V7a — sayfaya özel web app manifest'i. */

type Manifest = {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  lang: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

async function fetchManifest(cookie?: string, path = "/portal/manifest.webmanifest") {
  const res = await GET(portalRequest(path, { cookie }));
  return { res, body: (await res.json()) as Manifest };
}

let clientA: { id: string };
let clientB: { id: string };
let userA: { id: string; clientId: string };

beforeEach(async () => {
  await resetDb();
  const agency = await createAgency();
  clientA = await createClient(agency.id);
  clientB = await createClient(agency.id);
  await db.client.update({
    where: { id: clientA.id },
    data: {
      name: "Furkan Teacher Teaching",
      appName: "Furkan Teacher",
      appShortName: "Furkan",
      appThemeColor: "#1E3A34",
      appIconBase: "/icons/furkan-teacher",
    },
  });
  await db.client.update({
    where: { id: clientB.id },
    data: {
      name: "Gizli Müşteri B",
      appName: "B Uygulaması",
      appShortName: "BUyg",
      appThemeColor: "#ff0000",
      appIconBase: "/icons/musteri-b",
    },
  });
  userA = await createClientUser(clientA.id);
});

describe("GET /portal/manifest.webmanifest", () => {
  it("başlıklar: manifest+json, kişiye özel ve önbelleksiz", async () => {
    const { res } = await fetchManifest();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect(res.headers.get("cache-control")).toBe("private, max-age=0");
  });

  it("oturumsuz: nötr varsayılan ad ve ikon seti", async () => {
    const { body } = await fetchManifest();
    expect(body.name).toBe("Video Kuyruğu");
    expect(body.short_name).toBe(DEFAULT_PORTAL_APP.shortName);
    expect(body.icons.map((i) => i.src)).toEqual([
      "/icons/varsayilan/icon-192.png",
      "/icons/varsayilan/icon-512.png",
      "/icons/varsayilan/maskable-512.png",
    ]);
  });

  it("sabit alanlar", async () => {
    const { body } = await fetchManifest();
    expect(body).toMatchObject({
      id: "/portal",
      start_url: "/portal",
      display: "standalone",
      orientation: "portrait",
      lang: "tr",
    });
    // start_url kapsamın İÇİNDE olmalı (düz önek eşleşmesi); "/portal/"
    // kapsamı "/portal" açılış sayfasını kapsamazdı — bkz. portal-app.ts.
    expect(body.start_url.startsWith(body.scope)).toBe(true);
    expect(body.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(body.background_color).toMatch(/^#[0-9a-f]{6}$/);
    const maskable = body.icons.filter((i) => i.purpose === "maskable");
    expect(maskable).toHaveLength(1);
    expect(maskable[0]).toMatchObject({ sizes: "512x512", type: "image/png" });
    expect(body.icons.find((i) => i.sizes === "192x192")).toBeTruthy();
  });

  it("oturumlu: müşterinin app* alanları", async () => {
    const { body } = await fetchManifest(portalCookie(userA));
    expect(body.name).toBe("Furkan Teacher");
    expect(body.short_name).toBe("Furkan");
    expect(body.theme_color).toBe("#1e3a34");
    expect(body.icons.map((i) => i.src)).toEqual([
      "/icons/furkan-teacher/icon-192.png",
      "/icons/furkan-teacher/icon-512.png",
      "/icons/furkan-teacher/maskable-512.png",
    ]);
  });

  it("app* alanları boşsa ad Client.name'den, kısa ad ilk 12 karakter, ikon varsayılan", async () => {
    await db.client.update({
      where: { id: clientA.id },
      data: { appName: null, appShortName: null, appThemeColor: null, appIconBase: null },
    });
    const { body } = await fetchManifest(portalCookie(userA));
    expect(body.name).toBe("Furkan Teacher Teaching");
    expect(body.short_name).toBe("Furkan Teach");
    expect(body.icons[0].src).toBe("/icons/varsayilan/icon-192.png");
  });

  it("başka müşterinin bilgisi sızmaz — sorgu parametresi yok sayılır", async () => {
    const { body } = await fetchManifest(
      portalCookie(userA),
      `/portal/manifest.webmanifest?clientId=${clientB.id}`
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain("Gizli Müşteri B");
    expect(text).not.toContain("B Uygulaması");
    expect(text).not.toContain("musteri-b");
    expect(text).not.toContain("#ff0000");
    expect(body.name).toBe("Furkan Teacher");
  });

  it("çerezde clientId değiştirilmiş (imzası bozuk ya da kullanıcıya uymayan) oturum varsayılana düşer", async () => {
    // Geçerli imzalı ama kullanıcının müşterisi DEĞİL: getClientSession reddeder.
    const { value } = signClientSession({ clientUserId: userA.id, clientId: clientB.id });
    const { body } = await fetchManifest(`${CLIENT_SESSION_COOKIE}=${value}`);
    expect(body.name).toBe("Video Kuyruğu");
    expect(JSON.stringify(body)).not.toContain("musteri-b");
  });
});

describe("GET /portal/manifest.webmanifest — oturumsuz, iz çerezli (K29)", () => {
  it("izli istek: son giriş yapılan müşterinin adı ve ikonu", async () => {
    const { body } = await fetchManifest(portalTraceCookie(clientA.id));
    expect(body.name).toBe("Furkan Teacher");
    expect(body.short_name).toBe("Furkan");
    expect(body.theme_color).toBe("#1e3a34");
    expect(body.icons[0].src).toBe("/icons/furkan-teacher/icon-192.png");
  });

  it("izsiz istek: varsayılan", async () => {
    const { body } = await fetchManifest();
    expect(body).toMatchObject({ name: "Video Kuyruğu", short_name: "Kuyruk" });
  });

  it("oturum varsa oturum kazanır (iz başka müşteriyi gösterse bile)", async () => {
    const { body } = await fetchManifest(
      `${portalCookie(userA)}; ${portalTraceCookie(clientB.id)}`
    );
    expect(body.name).toBe("Furkan Teacher");
    expect(JSON.stringify(body)).not.toContain("musteri-b");
  });

  it("silinmiş müşterinin izi varsayılana düşer", async () => {
    const cookie = portalTraceCookie(clientB.id);
    await db.client.delete({ where: { id: clientB.id } });
    const { res, body } = await fetchManifest(cookie);
    expect(res.status).toBe(200);
    expect(body.name).toBe("Video Kuyruğu");
  });

  it("imzası bozuk iz (clientId elle değiştirilmiş) varsayılana düşer", async () => {
    const [prefix, , sig] = signPortalTrace(clientA.id).value.split(".");
    const forged = Buffer.from(
      JSON.stringify({ c: clientB.id, exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString("base64url");
    const { body } = await fetchManifest(`${CLIENT_TRACE_COOKIE}=${prefix}.${forged}.${sig}`);
    expect(body.name).toBe("Video Kuyruğu");
    expect(JSON.stringify(body)).not.toContain("musteri-b");
  });

  it("düz clientId (imzasız) iz varsayılana düşer", async () => {
    const { body } = await fetchManifest(`${CLIENT_TRACE_COOKIE}=${clientA.id}`);
    expect(body.name).toBe("Video Kuyruğu");
  });

  it("iz yalnızca ad/ikon/renk verir — müşteri e-postası manifest'e çıkmaz", async () => {
    const client = await db.client.findUniqueOrThrow({ where: { id: clientA.id } });
    const { body } = await fetchManifest(portalTraceCookie(clientA.id));
    expect(JSON.stringify(body)).not.toContain(client.email);
  });
});

describe("resolvePortalApp — bozuk alanlar varsayılana düşer", () => {
  const base = {
    name: "Müşteri",
    appName: null,
    appShortName: null,
    appThemeColor: null,
    appIconBase: null,
  };

  it.each([
    "https://kotu.example/icons",
    "//kotu.example/x",
    "/icons/../api",
    "/icons/",
    "javascript:alert(1)",
    "/uploads/x",
  ])("dış/bozuk ikon kökü reddedilir: %s", (appIconBase) => {
    expect(resolvePortalApp({ ...base, appIconBase }).iconBase).toBe("/icons/varsayilan");
  });

  it.each(["red", "#fff", "#12345g", "url(x)"])("bozuk renk reddedilir: %s", (appThemeColor) => {
    expect(resolvePortalApp({ ...base, appThemeColor }).themeColor).toBe(
      DEFAULT_PORTAL_APP.themeColor
    );
  });

  it("kısa ad Türkçe harfleri ortadan bölmez", () => {
    expect(resolvePortalApp({ ...base, name: "Öğretmen Şükrü Çağlayan" }).shortName).toBe(
      "Öğretmen Şük"
    );
  });

  it("oturum yoksa varsayılan", () => {
    expect(resolvePortalApp(null)).toEqual(DEFAULT_PORTAL_APP);
  });
});
