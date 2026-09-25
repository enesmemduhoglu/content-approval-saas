import { NextResponse } from "next/server";
import {
  CLIENT_SESSION_TTL_SECONDS,
  clientSessionRenewAt,
  getClientSessionWithExpiry,
  setClientSessionCookie,
  shouldRenewClientSession,
} from "@/lib/client-auth";
import { portalMutationGuard } from "@/lib/portal-route";

/**
 * V7a — kaydırmalı oturum (K25): kalan süre 15 günün altındaysa çerezi
 * yeniden 30 güne uzatır.
 *
 * ─── Neden ayrı bir route ──────────────────────────────────────────────────
 * Portal sayfaları server component; server component çerez YAZAMAZ
 * (Next yalnızca route handler ve Server Action'da izin verir). Seçenekler:
 *  • middleware: projede hiç yok ve CSP nonce'ı için bile bilerek eklenmedi
 *    (next.config.ts) — her isteği oradan geçirmek yeni bir hata yüzeyi;
 *  • her portal route'unun yanıtına yenileme eklemek: 12+ route'a dokunur,
 *    birinde unutulması sessizdir;
 *  • bu route: layout çerezin bitişini okur, vakti geldiyse küçük bir istemci
 *    bileşeni (`session-keeper.tsx`) buraya bir POST atar. Normal günde hiç
 *    istek yok; 15 günde bir tek istek.
 *
 * Mutasyon sayılır (çerez yazıyor): `portalMutationGuard` sırası — oturum →
 * origin → hız sınırı. Oturumsuz istek 401; bu route oturum DOĞURMAZ, yalnızca
 * geçerli olanı uzatır, yani çalınmış-ama-süresi-dolmuş bir çerez burada
 * dirilemez (doğrulama süreyi de kontrol ediyor).
 */
export async function POST(request: Request) {
  const guard = await portalMutationGuard(request, { action: "session", max: 10 });
  if (!guard.ok) return guard.response;

  // Guard oturumu doğruladı; bitiş zamanı için aynı doğrulama bir kez daha
  // (DB'ye tek küçük sorgu). Guard'ın dönüşünü genişletmek diğer 12 route'un
  // tipini değiştirirdi.
  const current = await getClientSessionWithExpiry(request);
  if (!current) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  if (!shouldRenewClientSession(current.expiresAt)) {
    return NextResponse.json({
      ok: true,
      renewed: false,
      renewAt: clientSessionRenewAt(current.expiresAt).toISOString(),
    });
  }

  // İstemci httpOnly çerezi okuyamaz; bir sonraki kontrolün zamanını gövdeden
  // öğrenir (`session-keeper.tsx`). Aynı `now` hem çereze hem gövdeye gidiyor.
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CLIENT_SESSION_TTL_SECONDS * 1000);
  const response = NextResponse.json({
    ok: true,
    renewed: true,
    renewAt: clientSessionRenewAt(expiresAt).toISOString(),
  });
  setClientSessionCookie(response, current.session, now);
  return response;
}
