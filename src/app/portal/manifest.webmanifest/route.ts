import { getClientSession } from "@/lib/client-auth";
import { buildPortalManifest, loadPortalApp } from "@/lib/portal-app";

/**
 * V7a — portalın web app manifest'i, müşteriye göre.
 *
 * Neden `src/app/manifest.ts` değil: o dosya build'de TEK bir sabit manifest
 * üretir; uygulama adı ve ikonu ise sayfaya özel (K23). Oturum varsa
 * müşterinin adı/ikonu, yoksa nötr varsayılan (giriş ekranından eklenirse).
 *
 * Oturum yalnızca çerezden — sorgu parametresi, başlık ya da yoldan müşteri
 * seçilemez; başka müşterinin adı/ikonu bu route'tan hiçbir yolla okunamaz.
 *
 * Tarayıcı manifest'i varsayılan olarak ÇEREZSİZ ister; çerezin gitmesi
 * için `<link rel="manifest">` `crossorigin="use-credentials"` taşımalı
 * (portal layout'unda elle yazılmasının sebebi bu).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getClientSession(request);
  const app = await loadPortalApp(session);
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
