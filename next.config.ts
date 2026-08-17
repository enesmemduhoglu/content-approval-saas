import type { NextConfig } from "next";

/**
 * Güvenlik başlıkları.
 *
 * Buradaki asıl mesele `frame-ancestors 'none'`: onay sayfası (`/approve/[token]`)
 * giriş gerektirmiyor ve Instagram bağlı müşteride "Onayla" butonu doğrudan
 * YAYIN tetikliyor. Başlık yokken sayfa iframe'lenebiliyordu, yani clickjacking
 * ile atılan tek bir tık içeriği canlıya alabilirdi — geri alınamayan bir işlem.
 * Bu yüzden kapı tüm site için kapatılıyor; uygulamanın hiçbir sayfası
 * gömülmek üzere tasarlanmadı.
 *
 * `Referrer-Policy` ikinci sırada ama önemli: approval token'ı URL'in kendisinde
 * duruyor ve varsayılan davranışta dış bir host'a gidildiğinde `Referer`
 * başlığıyla sızabilirdi. Sayfa içindeki dış linkler zaten `rel="noreferrer"`
 * taşıyor; bu, o korumanın site geneli varsayılanı.
 */

// CSP'de bilinçli gevşek bırakılan iki yön — sebepleri:
//
// • `'unsafe-inline'` (script): Next.js App Router hidrasyon verisini inline
//   script olarak gömüyor. Nonce'a geçmek `middleware.ts` eklemeyi ve her
//   isteği oradan geçirmeyi gerektirir; bu projede middleware hiç yok ve
//   sırf bunun için eklemek yeni bir hata yüzeyi açar. 'unsafe-inline' inline
//   script'e izin verse de DIŞ origin'den script yüklenmesini yine engeller.
//
// • `img-src ... https:`: post görselleri Vercel Blob'dan, makine API'siyle
//   gelenler `raw.githubusercontent.com`'dan, yerelde ise `/uploads`'tan
//   geliyor. Host'u daraltmak, Blob store adı değiştiğinde ya da
//   `ALLOWED_IMAGE_URL_HOSTS`'a yeni host eklendiğinde onay sayfasındaki
//   görseli SESSİZCE kırar — ürünün tam kalbi. Sunucu tarafında zaten bir
//   allowlist var (`validation.ts`), bu yüzden burada https: yeterli kabul
//   edildi; `http:` ve `data:` dışı şemalar yine kapalı.
// Next.js'in DEV sunucusu HMR ve source map'ler için `eval()` kullanır. Bu izin
// olmadan istemci JS'i hiç çalışmaz: sayfa sunucudan render olmuş görünür ama
// hidrasyon sessizce ölür — butonlar tıklanır, hiçbir şey olmaz. (Tam olarak bu
// yaşandı: CSP eklendiğinde e2e testlerinin üçü "Yeni Müşteri'ye tıkladım, form
// açılmadı" diye düştü.) Production build'de eval kullanılmaz, orada verilmez.
const DEV_SCRIPT_SRC = process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'";

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEV_SCRIPT_SRC}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  // `frame-ancestors`'ın eski tarayıcılardaki karşılığı — ikisi birlikte durur.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Uygulama bu üçünü hiç kullanmıyor; kapalı olduklarını açıkça söyle.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // `preload` BİLEREK yok: preload listesine girmek geri alınması zor bir
  // taahhüt ve alan adı kararı (`enesmemduhoglu.tech` şu an yalnızca e-posta
  // için kullanılıyor). max-age + includeSubDomains koruma için yeterli.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
