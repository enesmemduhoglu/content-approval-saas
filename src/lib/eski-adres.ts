import type { Redirect } from "next/dist/lib/load-custom-routes";

/**
 * Eski `*.vercel.app` adresinden `APP_URL`'e yönlendirme (2026-11-15).
 *
 * Neden: Türkiye'deki mobil operatörler `vercel.app`'i toptan engelleyebiliyor
 * (2023-12'de USOM kararıyla yaşandı; 2026-11'de bir müşterinin LTE'sinde portal
 * yine açılmadı, VPN'le açıldı). Sunucu sağlam, telefon adrese hiç ulaşamıyor —
 * kodla çözülecek bir şey değil, uygulama kendi alan adına taşındı. Bu kural
 * eski linklerden (e-postalar, ana ekran kısayolu) gelen ve eski adrese hâlâ
 * ulaşabilen (Wi-Fi, VPN) kullanıcıyı yeni adrese taşır.
 *
 * Yönlendirilmeyenler — her biri bilinçli:
 *  • `/api/**`: furi'nin makine yolu ve önceden kurulmuş QStash mesajları
 *    (QueueWake `notBefore`'la günler sonrası için kurulmuş olabilir) eski
 *    adresi çağırıyor. Başka origin'e yönlendirilen istekte `fetch`
 *    `Authorization` başlığını DÜŞÜRÜR, QStash imzası da URL'e bağlı — yani
 *    yönlendirme ikisini de sessizce kırardı. API eski adreste aynen çalışır.
 *  • `/_next/**`: eski adreste açık kalmış bir sekmenin parça yüklemesi
 *    başka origin'e kaçmasın.
 *  • `/sw.js`: service worker betiğinin yanıtı yönlendirme olamaz (tarayıcı
 *    güncellemeyi reddeder); eski origin'deki worker güncellenebilir kalsın.
 *
 * `permanent: false` (307): 308'i tarayıcı süresiz önbelleğe alır; alan adı
 * kararı geri alınırsa kullanıcı yeni adrese kilitli kalırdı.
 *
 * Kural yalnızca `APP_URL` eski adresten FARKLI bir hostu gösterirken üretilir.
 * `APP_URL` yalnızca Production ortamında tanımlı: preview build'i bu kuralı
 * hiç almaz, `has: host` koşulu da ayrıca yalnızca eski prod hostunu eşler.
 */
export const ESKI_HOST = "content-approval-saas.vercel.app";

export function eskiAdresYonlendirmeleri(appUrl: string | undefined): Redirect[] {
  if (!appUrl) return [];
  let hedef: URL;
  try {
    hedef = new URL(appUrl);
  } catch {
    // Bozuk APP_URL build'i düşürmesin; yönlendirme olmadan eski hâl sürer.
    return [];
  }
  if (hedef.host === ESKI_HOST) return [];
  const kok = hedef.origin;
  const has = [{ type: "host" as const, value: ESKI_HOST }];
  return [
    // Kök ayrı kural: `/:path(...)` boş yolu eşlemiyor.
    { source: "/", has, destination: `${kok}/`, permanent: false },
    {
      source: "/:path((?!api/|_next/|sw\\.js$).+)",
      has,
      destination: `${kok}/:path`,
      permanent: false,
    },
  ];
}
