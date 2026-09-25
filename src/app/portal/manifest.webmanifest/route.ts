import { getClientSession } from "@/lib/client-auth";
import { buildPortalManifest, loadPortalApp } from "@/lib/portal-app";

/**
 * V7a — portalın web app manifest'i, müşteriye göre.
 *
 * Neden `src/app/manifest.ts` değil: o dosya build'de TEK bir sabit manifest
 * üretir; uygulama adı ve ikonu ise sayfaya özel (K23). Oturum varsa
 * müşterinin adı/ikonu; yoksa bu cihazda en son giriş yapılan müşterinin
 * imzalı izi (K29 — oturumu düşmüş cihaz yine kendi markasını kursun); o da
 * yoksa nötr varsayılan.
 *
 * Müşteri yalnızca çerezden (oturum ya da imzalı iz) — sorgu parametresi,
 * başlık ya da yoldan seçilemez; başka müşterinin adı/ikonu bu route'tan
 * hiçbir yolla okunamaz.
 *
 * Tarayıcı manifest'i varsayılan olarak ÇEREZSİZ ister; çerezin gitmesi
 * için `<link rel="manifest">` `crossorigin="use-credentials"` taşımalı
 * (portal layout'unda elle yazılmasının sebebi bu).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getClientSession(request);
  const app = await loadPortalApp(session, request);
  return new Response(JSON.stringify(buildPortalManifest(app)), {
    headers: {
      "Content-Type": "application/manifest+json",
      // Kişiye özel: CDN'de ya da paylaşılan önbellekte tutulursa bir
      // müşterinin adı/ikonu başka birine servis edilir.
      "Cache-Control": "private, max-age=0",
      // Aynı URL çereze göre farklı içerik döndürüyor.
      Vary: "Cookie",
    },
  });
}
