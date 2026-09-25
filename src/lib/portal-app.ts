import { cache } from "react";
import { getClientSessionWithExpiry, type ClientSession } from "@/lib/client-auth";
import { getClientScopedDb } from "@/lib/client-scoped-db";

/**
 * V7a — portalın "uygulama kimliği": ad, kısa ad, tema rengi, ikon seti.
 * Manifest route'u (Android/Chrome kurulumu) ve portal layout'unun iOS meta
 * etiketleri AYNI çözümlemeyi kullanır; ikisi ayrı hesaplasaydı iPhone'da ve
 * Android'de aynı müşteri farklı adla kurulabilirdi.
 *
 * Uygulama adı ve ikonu SAYFAYA ÖZEL (K23): oturum varsa müşterinin `app*`
 * alanları, yoksa nötr varsayılan. iOS adı ve ikonu "Ana Ekrana Ekle" anında
 * kopyalayıp bir daha güncellemediği için kullanıcıya uygulamayı GİRİŞ
 * YAPTIKTAN SONRA eklemesi söylenir (V7-pwa §4.1).
 */

export type PortalApp = {
  name: string;
  shortName: string;
  themeColor: string;
  backgroundColor: string;
  iconBase: string;
};

/** portal.css `--p-bg` (krem): açılış ekranı ve durum çubuğu sayfayla aynı zeminde dursun. */
const DEFAULT_BG = "#faf6e9";
export const DEFAULT_ICON_BASE = "/icons/varsayilan";
export const DEFAULT_PORTAL_APP: PortalApp = {
  name: "Video Kuyruğu",
  // 12 karakteri aşan kısa ad iOS/Android ana ekranında "Video Kuyru…" diye kesilir.
  shortName: "Kuyruk",
  themeColor: DEFAULT_BG,
  backgroundColor: DEFAULT_BG,
  iconBase: DEFAULT_ICON_BASE,
};

const SHORT_NAME_MAX = 12;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/**
 * İkon kökü yalnızca "/icons/<klasör>" biçiminde kabul edilir. Alan bugün
 * yalnızca elle (DB) dolduruluyor ama değeri manifest'e ve `<link>`'e
 * YAZILIYOR: dış bir host ya da `javascript:` gibi bir değer, müşterinin ana
 * ekran ikonunu başkasının sunucusuna bağlardı.
 */
const ICON_BASE = /^\/icons\/[a-z0-9][a-z0-9-]*$/;

type ClientAppFields = {
  name: string;
  appName: string | null;
  appShortName: string | null;
  appThemeColor: string | null;
  appIconBase: string | null;
};

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Saf: müşteri alanlarından uygulama kimliği. Boş/bozuk her alan varsayılana düşer. */
export function resolvePortalApp(client: ClientAppFields | null): PortalApp {
  if (!client) return DEFAULT_PORTAL_APP;
  const name = clean(client.appName) ?? clean(client.name) ?? DEFAULT_PORTAL_APP.name;
  // Array.from: "ğ", "ş" gibi harfler ve emoji ortadan bölünmesin.
  const shortName =
    clean(client.appShortName) ?? Array.from(name).slice(0, SHORT_NAME_MAX).join("").trim();
  const themeColor =
    client.appThemeColor && HEX_COLOR.test(client.appThemeColor)
      ? client.appThemeColor.toLowerCase()
      : DEFAULT_PORTAL_APP.themeColor;
  const iconBase =
    client.appIconBase && ICON_BASE.test(client.appIconBase)
      ? client.appIconBase
      : DEFAULT_ICON_BASE;
  return { name, shortName, themeColor, backgroundColor: DEFAULT_BG, iconBase };
}

/** Oturumdaki müşterinin uygulama kimliği; kapsam `client-scoped-db`'den (IDOR). */
export async function loadPortalApp(session: ClientSession | null): Promise<PortalApp> {
  if (!session) return DEFAULT_PORTAL_APP;
  const client = await getClientScopedDb(session).client.getApp();
  return resolvePortalApp(client);
}

/**
 * Portal layout'u için istek başına TEK çözümleme. `generateMetadata`,
 * `generateViewport` ve layout'un kendisi aynı render'da ayrı ayrı çağırıyor;
 * `cache` olmadan her biri çerezi doğrulayıp DB'ye giderdi.
 */
export const getPortalContext = cache(async () => {
  const current = await getClientSessionWithExpiry();
  const app = await loadPortalApp(current?.session ?? null);
  return { session: current?.session ?? null, expiresAt: current?.expiresAt ?? null, app };
});

/**
 * Web app manifest. Sabit alanlar V7-pwa §4.1'den; `scope` bilinçli olarak
 * "/portal" (sonda eğik çizgi YOK) — bkz. aşağıdaki not.
 *
 * `scope: "/portal/"` + `start_url: "/portal"` birlikte GEÇERSİZ: manifest
 * kapsam eşleşmesi düz önek karşılaştırması ve "/portal" dizgesi "/portal/"
 * ile başlamıyor. Tarayıcı bu durumda `scope`'u yok sayar ya da açılış
 * sayfasını kapsam dışı sayıp standalone pencerede adres çubuğu gösterir.
 * Next `trailingSlash` kullanmadığı için "/portal/" zaten "/portal"a
 * yönleniyor; tutarlı olan kapsamı "/portal" yapmak. (Yan etkisi "/portalx"
 * gibi yolları da kapsaması — öyle bir yol yok.)
 */
export function buildPortalManifest(app: PortalApp) {
  return {
    id: "/portal",
    name: app.name,
    short_name: app.shortName,
    start_url: "/portal",
    scope: "/portal",
    display: "standalone",
    orientation: "portrait",
    lang: "tr",
    dir: "ltr",
    background_color: app.backgroundColor,
    theme_color: app.themeColor,
    icons: [
      { src: `${app.iconBase}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `${app.iconBase}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: `${app.iconBase}/maskable-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
