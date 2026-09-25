import type { Metadata, Viewport } from "next";
import { getPortalContext } from "@/lib/portal-app";
import { clientSessionRenewAt } from "@/lib/client-auth";
import { ServiceWorkerRegister } from "@/components/portal/sw-register";
import { SessionKeeper } from "@/components/portal/session-keeper";
import "./portal.css";

// Portal stilleri ayrı dosyada: `globals.css` ajans paneliyle ortak ve video
// kuyruğunun diğer fazlarıyla paralel değişebilir; portalın kuralları burada
// durursa birleştirme çakışması doğmaz. Renk/tipografi değişkenleri yine
// globals.css'ten (D7) geliyor — görsel dil ortak.

/**
 * V7a — iOS "Ana Ekrana Ekle" manifest'i OKUMAZ; adı `apple-mobile-web-app-title`
 * meta'sından, ikonu `apple-touch-icon`'dan alır ve EKLEME ANINDA kopyalar.
 * Bu yüzden ikisi de oturuma göre (müşterinin adı/ikonu) sunucuda üretiliyor.
 *
 * `manifest` BURADA YOK, bilinçli: Next metadata'sı `<link rel="manifest">`'i
 * `crossorigin` olmadan basıyor (yalnızca Vercel preview'da `use-credentials`
 * ekliyor). Tarayıcı çerezsiz ister, manifest route'u oturumu göremez ve
 * Android'de uygulama her zaman varsayılan adla kurulurdu. Link aşağıda,
 * layout gövdesinde elle — React 19 `<link>`'i `<head>`'e taşıyor.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { app } = await getPortalContext();
  return {
    title: "Video Portalı",
    description: "Videolarını yükle, sırala, yayın saatlerini seç",
    appleWebApp: {
      capable: true,
      // Ana ekranda simgenin altındaki ad; ~12 karakterden uzunu kesilir.
      title: app.shortName,
      // "default": açık zemin üzerinde koyu durum çubuğu — portal açık temalı.
      // "black-translucent" içeriği çentiğin altına iterdi; güvenli alan payları
      // (§4.4) gelmeden seçilmemeli.
      statusBarStyle: "default",
    },
    icons: { apple: `${app.iconBase}/icon-180.png` },
    // Next 15.5 `capable: true` için yalnızca standart `mobile-web-app-capable`
    // basıyor; manifest'i okumayan eski iOS sürümleri ana ekrandan açılışta
    // tam ekranı bu eski adla tanıyor.
    other: { "apple-mobile-web-app-capable": "yes" },
  };
}

/**
 * `generateViewport` (sabit `viewport` değil): `themeColor` müşteriye göre.
 * `viewportFit: "cover"` sayfayı çentik/ev çubuğu alanına kadar uzatır;
 * `env(safe-area-inset-*)` payları ancak bununla anlamlı.
 */
export async function generateViewport(): Promise<Viewport> {
  const { app } = await getPortalContext();
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: app.themeColor,
  };
}

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { session, expiresAt } = await getPortalContext();
  return (
    <>
      <link rel="manifest" href="/portal/manifest.webmanifest" crossOrigin="use-credentials" />
      {children}
      <ServiceWorkerRegister />
      {session && expiresAt && (
        <SessionKeeper renewAt={clientSessionRenewAt(expiresAt).getTime()} />
      )}
    </>
  );
}
