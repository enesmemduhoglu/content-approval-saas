/**
 * CSRF ikinci savunma katmanı (S8).
 *
 * NextAuth v5 oturum çerezi `SameSite=Lax` ile işaretli, yani cross-site bir
 * POST'ta çerez zaten tarayıcı tarafından gönderilmiyor — bugün sömürülebilir
 * bir açık YOK. Ama `/api/posts` ve `/api/agency` `multipart/form-data` kabul
 * ediyor; bu, CORS'un "basit istek" (simple request) sınıfına girer ve
 * preflight OPTIONS olmadan gönderilebilir. Yani tek savunma katmanı tek bir
 * çerez ayarına dayanıyor. `Origin` başlığını kontrol etmek ucuz bir İKİNCİ
 * katman — SameSite'ın yerini almaz, üzerine eklenir.
 */

/**
 * "Kendi origin'imiz" burada SABİT KODLANMAZ. İsteğin kendi `Host` /
 * `X-Forwarded-Host` başlığından türetilir — env'den (ör. NEXTAUTH_URL) değil.
 *
 * Neden: Vercel'de her PR/branch için preview dağıtımı FARKLI bir alan adı
 * alır (ör. `content-approval-saas-git-foo-team.vercel.app`). Bu alan
 * adlarının hepsini bir env değişkeninde toplamaya çalışmak kırılgan olur ve
 * her yeni PR'da panel Origin kontrolüne takılıp çalışmaz hale gelirdi. Oysa
 * bir isteği karşılayan sunucu HER ZAMAN o isteğin kendi Host başlığını
 * görür — preview A'ya gelen istek preview A'nın host'unu taşır, preview
 * B'ye gelen istek B'ninkini. Origin'i "isteğin kendi host'u"yla
 * karşılaştırmak bu yüzden env listesi bakımı gerektirmeden otomatik olarak
 * her ortamda (local/prod/her preview) doğru çalışır.
 */
export function deriveOwnOrigin(request: Request): string {
  // Vercel gibi proxy arkasında çalışan ortamlarda gerçek dış host
  // x-forwarded-host'ta taşınır; doğrudan bağlantıda (ör. testler, local)
  // sade `host` başlığına düşülür.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) {
    const proto =
      request.headers.get("x-forwarded-proto") ??
      new URL(request.url).protocol.replace(":", "");
    return `${proto}://${host}`;
  }
  // Ne host ne x-forwarded-host varsa (pratikte olmaz ama testlerde
  // `new Request(url)` başlıksız kurulabiliyor) isteğin kendi URL'inden
  // türetilen origin'e düş.
  return new URL(request.url).origin;
}

export type OriginCheckResult = { ok: true } | { ok: false; message: string };

/**
 * Yalnızca durum DEĞİŞTİREN metotlarda (POST/PUT/PATCH/DELETE) çağrılmalı —
 * GET zaten yan etkisiz, CSRF'in konusu değil.
 *
 * `Origin` başlığı YOKSA kabul ediyoruz. Gerekçe: bu başlığı tarayıcı-dışı
 * istemciler (curl, sunucu-sunucu çağrıları, bazı eski/özel HTTP
 * istemcileri) hiç göndermez; bu yollar zaten oturum çerezi (SameSite=Lax)
 * ile korunuyor, dolayısıyla başlıksız isteği reddetmek gerçek kullanıcılar
 * için yanlış pozitif üretir. Kabul etmek bu ikinci katmanı gerçek bir
 * CSRF saldırganına karşı biraz zayıflatır (saldırgan tarayıcı dışı bir araçla
 * Origin'siz istek gönderebilir) — ama saldırganın çerezi zaten yok (SameSite
 * onu engelliyor), yani bu senaryoda zaten bir şey kaybetmiyoruz. Kayıp
 * yalnızca "Origin'i taklit edip gönderen ama çerezi olmayan" bir saldırgana
 * karşı; o saldırgan zaten 401 ile durduruluyor.
 */
export function checkOrigin(request: Request): OriginCheckResult {
  const origin = request.headers.get("origin");
  if (!origin) return { ok: true };

  const ownOrigin = deriveOwnOrigin(request);
  if (origin === ownOrigin) return { ok: true };

  return {
    ok: false,
    message: "İstek güvenilmeyen bir kaynaktan geldiği için reddedildi",
  };
}
