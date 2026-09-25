# V7 — Portal telefonda uygulama olarak (PWA)

> **Durum: ⬜ planlandı, uygulanmadı.** Kullanıcı başlatana kadar kod yazılmaz.
> Kararlar: [K23](KARARLAR.md), [K25](KARARLAR.md). Faz durumu: [`FAZLAR.md`](FAZLAR.md).
> Plan yazılırken master: `15ae578` (#69). Satır/dosya atıfları o duruma göre;
> uygulamadan önce yeniden doğrula.

## 1. Neden ve neden PWA

Sayfa sahibi videoyu telefonla çekiyor, telefonda düzenliyor (kırpma, renk —
[V6 iptal](V6-kare-kirpma.md), K24) ve **telefondan yükleyecek.** Portal
bugün yalnızca bir web sayfası.

**Neden yerel uygulama değil:** App Store yıllık 99 $, her güncellemede Apple
incelemesi, ayrı kod tabanı. Kullanıcının işi dar (yükle, sırala, onayla,
bildirim al); bunun için PWA'nın eksiği yok, aynı Next.js kodu kalıyor.

**Neden yalnızca "ana ekrana eklenebilir site" yetmez:** telefonda gerçekten
sorun çıkaracak dört şey var ve V7'nin değeri bunları çözmek:

| Sorun | Neden | Çözüm | Bölüm |
|---|---|---|---|
| iPhone'da ana ekran uygulamasında oturum açılmıyor | iOS'ta kurulu PWA'nın çerez deposu Safari'den ayrı; e-postadaki link Safari'de açılır | E-postaya 6 haneli kod, uygulamada kodla giriş | V7a |
| Yükleme sırasında uygulamadan çıkınca yükleme baştan başlıyor | iOS arka plandaki sayfayı askıya alır; 150 MB tek PUT yarıda kalır | R2 çok parçalı yükleme, kaldığı yerden devam | V7b |
| E-postalar spam'e düşebiliyor (2026-09-25'te görüldü) | Gmail filtresi | Telefona anlık bildirim (Web Push); e-posta yedek | V7c |
| Android'de galeriden doğrudan gönderme | — | Manifest `share_target` | V7d |

## 2. Kullanıcı kararları (2026-09-25)

| Soru | Karar |
|---|---|
| Kapsam | **V7a + V7b + V7c + V7d** (dördü de) |
| Öncelikli cihaz | **iPhone** — her tasarım kararı önce iOS Safari/PWA kısıtlarına göre |
| Uygulama adı ve ikonu | **Sayfaya özel** (ör. Furkan'ın adı/logosu) — ileride her müşteri kendi adını/ikonunu görür |

**Sıra:** V7a → V7b → V7c → V7d. V7a temel (kurulum + giriş); V7c ve V7d
service worker'a dayanıyor; V7d Android'e özel olduğu için en sonda.

## 3. Bugünkü durum (ölçüldü, 2026-09-25)

- Web app manifest, ikon, service worker **yok**; `public/` altında yalnızca
  `uploads/`.
- `src/app/layout.tsx` yalnızca `metadata` export ediyor; `viewport` /
  `themeColor` / `appleWebApp` yok. `src/app/portal/layout.tsx` kendi
  `metadata`'sını export ediyor.
- Müşteri oturumu: HMAC imzalı çerez, **30 gün**
  (`src/lib/client-auth.ts` → `CLIENT_SESSION_TTL_SECONDS`), her istekte DB
  ile doğrulanıyor.
- Magic link: `ClientLoginToken` (yalnızca `tokenHash`), GET'te harcanmıyor,
  sayfadaki buton POST'la tüketiyor (K19).
- CSP (`next.config.ts`): `worker-src` / `manifest-src` tanımsız →
  `script-src 'self'` / `default-src 'self'`'e düşer; aynı kaynaktan servis
  edilen worker ve manifest izinli. `connect-src 'self' https://*.r2.cloudflarestorage.com`.
- R2 CORS: yalnızca `https://content-approval-saas.vercel.app` ve
  `http://localhost:3000`; `ExposeHeaders: ETag` **var** (V7b için gerekli).
- Yükleme: tek parça imzalı PUT (`upload-form.tsx` → `putWithProgress`),
  dosyalar sırayla.

## 4. V7a — Kurulum, kodla giriş, mobil arayüz

### 4.1 Sayfaya özel manifest (dinamik)
Sayfaya özel ad/ikon kararı yüzünden manifest **statik olamaz**
(`src/app/manifest.ts` tek bir sabit dosya üretir).

- **Route:** `src/app/portal/manifest.webmanifest/route.ts` (GET).
  - Müşteri oturumu varsa: `name` = `Client.appName ?? Client.name`,
    `short_name` = `Client.appShortName ?? ilk 12 karakter`,
    `icons` = müşterinin ikon seti, `theme_color` = `Client.appThemeColor`.
  - Oturum yoksa: nötr varsayılan ad/ikon (giriş ekranından eklenirse).
  - Sabit alanlar: `id: "/portal"`, `start_url: "/portal"`, `scope: "/portal/"`,
    `display: "standalone"`, `orientation: "portrait"`, `lang: "tr"`.
    **Uygulanan:** `scope: "/portal"` (eğik çizgisiz) — K26.
  - `Content-Type: application/manifest+json`,
    `Cache-Control: private, max-age=0` (kişiye özel; CDN'de paylaşılmasın).
- **Önemli iOS davranışı:** iOS adı ve ikonu **"Ana Ekrana Ekle" anında**
  kopyalar, sonra güncellemez. Kullanıcıya uygulamayı **giriş yaptıktan
  sonra** eklemesi söylenir (bkz. 4.5 kurulum rehberi).
- **Şema (göç, `nextjs-prisma:goc`):** `Client`'a `appName String?`,
  `appShortName String?`, `appThemeColor String?`, `appIconBase String?`
  (ikon setinin yolu/öneki). Hepsi nullable, mevcut satırlar etkilenmez.
- **İkonlar:** tek kaynak görselden (1024 px kare PNG — Furkan'ın logosu ya
  da profil görseli; kullanıcı verecek) betikle üretilir:
  `scripts/pwa-ikon-uret.mjs` → 180 (apple-touch), 192, 512, 512 maskable
  (güvenli alan payı). Nereye:
  - İlk sürüm: `public/icons/<client-slug>/` (repo public; logo zaten public).
  - Çok müşteride: R2 public olmadığı için Vercel Blob ya da `public/`.
    Karar V7a'da.

### 4.2 iOS meta ve viewport
- `src/app/portal/layout.tsx` → `generateMetadata` (oturuma göre):
  `manifest: "/portal/manifest.webmanifest"`,
  `appleWebApp: { capable: true, title, statusBarStyle: "default" }`,
  `icons.apple: <180 px ikon>`.
- `export const viewport`: `width: "device-width"`, `initialScale: 1`,
  `viewportFit: "cover"`, `themeColor`.
- Portal CSS: `env(safe-area-inset-top/bottom)` boşlukları (çentik, alttaki
  ev çubuğu).

### 4.3 Kodla giriş (iPhone için kritik)
- Giriş e-postası (`src/lib/email-portal.ts`): mevcut linkin yanına **6
  haneli kod** (büyük punto) ve "Uygulamadan giriyorsan bu kodu gir" notu.
- Giriş sayfası (`/portal/giris`): e-posta gönderildikten sonra **kod alanı**
  (`inputmode="numeric"`, `autocomplete="one-time-code"` — iOS kodu
  e-postadan önerebilir).
- **Route:** `POST /api/portal/login/code { email, code }` →
  kullanıcının en son, kullanılmamış, süresi geçmemiş token'ı; kod hash'i
  sabit zamanlı karşılaştırılır; başarıda koşullu UPDATE (`usedAt: null`)
  ile tüketilir ve aynı oturum çerezi kurulur (link akışıyla aynı fonksiyon).
- **Güvenlik:**
  - Kod ve link AYNI token satırına bağlı; biri kullanılınca ikisi de biter.
  - Yalnızca hash saklanır (token deseni).
  - Token başına en fazla **5 hatalı deneme** → token geçersiz (koşullu
    `attempts` artışı). 6 hane = 10⁶; sınır olmadan kaba kuvvete açık.
  - Ek rate limit: e-posta başına ve IP başına (`checkRateLimit`).
  - Yanıtlar e-postanın kayıtlı olup olmadığını sızdırmaz (K19'daki gibi).
- **Şema:** `ClientLoginToken`'a `codeHash String?`, `attempts Int @default(0)`.
- **Oturum süresi:** 30 gün sabit yerine **kaydırmalı**: kalan süre 15 günün
  altına düşünce çerez yenilenir (kullanan kişi hiç yeniden giriş yapmaz,
  bırakılan cihaz 30 günde düşer). Karar K25.

### 4.4 Mobil arayüz
- **Alt sekme çubuğu** (yalnızca dar ekranda): Kuyruk · Yükle · Geçmiş · Ayarlar;
  güvenli alan payıyla.
- Dokunma hedefleri ≥ 44 px; kuyrukta sürükle-bırak yerine yukarı/aşağı
  okları (V3'te var) mobilde öne çıkar.
- Dosya seçici `accept="video/*"` (iOS'ta "Fotoğraf Arşivi / Çek / Dosya Seç").
- Uzun işlemlerde (yükleme) sayfadan çıkma uyarısı.
- Instagram linkleri standalone modda dış uygulamada açılır (`target="_blank"`).

### 4.5 Kurulum rehberi (iPhone'da yükleme istemi yok)
iOS Safari "Yükle" istemi göstermez; kullanıcı elle ekler.
- Safari'de, standalone değilken (`navigator.standalone !== true`) ve iOS
  ise, giriş yapılmışken tek seferlik bir bant: "Uygulama olarak ekle:
  Paylaş → Ana Ekrana Ekle". Kapatılırsa `localStorage` ile bir daha
  gösterilmez (depolama erişimi try/catch).
- Android Chrome: `beforeinstallprompt` yakalanır, Ayarlar'da "Uygulamayı
  yükle" butonu.

### 4.6 Service worker (en küçüğü)
- `public/sw.js`, **kapsam `/portal/`** (`register("/sw.js", { scope: "/portal/" })`
  — dosya kökte, kapsam daraltılmış). Yalnızca production'da kaydedilir.
- **Önbellek kuralı (değişmez):** `/api/**`, R2 imzalı URL'ler ve oturumlu
  HTML **asla önbelleğe alınmaz.** Yalnızca: çevrimdışı sayfası
  (`/portal/cevrimdisi`, statik, oturumsuz) ve ikonlar.
  Navigasyon isteği → ağ; ağ yoksa çevrimdışı sayfası.
  Neden: bayat kuyruk durumu ya da başka bir kullanıcının sayfası
  gösterilmesin; imzalı URL'lerin süresi zaten doluyor.
- Güncelleme: yeni SW `waiting` olunca sayfada "Yeni sürüm hazır — yenile"
  bandı; `skipWaiting` yalnızca kullanıcı dokununca.
- `src/lib/csp.test.ts`: SW'nin aynı kaynaktan geldiği ve `blob:` worker'a
  izin verilmediği assertion'ı.

### 4.7 V7a doğrulama
1. Vitest: kodla giriş (doğru kod → oturum; yanlış kod → 5'te kilit; süre
   dolumu; link kullanıldıysa kod ölü ve tersi; hash saklama; enumeration
   yok; rate limit 429), kaydırmalı oturum yenileme, manifest route (oturumlu
   → müşteri adı; oturumsuz → varsayılan; başka müşteri sızmıyor).
2. iPhone (gerçek cihaz, prod ya da preview): Safari'de giriş → rehber
   bandı → Ana Ekrana Ekle → ikon ve ad doğru → PWA açılır → **kodla giriş**
   → kuyruk. Çentik/alt çubuk boşlukları.
3. Uçak modu → çevrimdışı sayfası; geri dönünce normal.
4. DevTools → Application → Cache Storage: `/api/**` ve portal HTML'i YOK.
5. Lighthouse (mobil) yüklenebilirlik.

## 5. V7b — Dayanıklı (kaldığı yerden devam eden) yükleme

### 5.1 Tasarım
- **R2 çok parçalı yükleme** (S3 multipart, R2 destekliyor):
  1. `POST /api/portal/upload` — dosya başına taslak Post + R2
     `CreateMultipartUpload` → `uploadId` sunucuda saklanır
     (**`Post.uploadId String?`**, göç). İstemciye `uploadId` değil yalnızca
     `postId` + parça boyutu döner.
  2. `POST /api/portal/videos/[id]/parts { partNumbers: number[] }` — o
     parçalar için imzalı `UploadPart` URL'leri (15 dk). Kapsam:
     `client-scoped-db` + `keyBelongsToClient`.
  3. İstemci parçaları doğrudan R2'ye PUT eder, her parçanın `ETag`'ini
     toplar (CORS `ExposeHeaders: ETag` zaten açık).
  4. `POST /api/portal/videos/[id]/complete { parts: [{n, etag}] }` →
     `CompleteMultipartUpload`, sonra mevcut `headObject` / boyut / tip
     kontrolleri aynen.
- **Parça boyutu:** 8 MB (S3 alt sınırı 5 MB, son parça hariç). 150 MB ≈ 19
  parça. Aynı anda 3 parça; parça başına üstel geri çekilmeli tekrar deneme.
- **Devam etme:**
  - Uygulama askıya alınıp dönünce (`visibilitychange` → visible) kalan
    parçalardan devam; tamamlananlar tekrar gönderilmez.
  - Sayfa yenilenirse/uygulama kapanırsa `File` nesnesi kaybolur (iOS'ta
    dosyaya kalıcı erişim yok). İlerleme IndexedDB'de
    `(dosya adı, boyut, lastModified)` anahtarıyla tutulur; kullanıcı
    **aynı videoyu yeniden seçerse** kaldığı parçadan devam eder. IndexedDB
    erişimi try/catch — yoksa baştan başlar.
- **Küçük dosyalar** (< 16 MB): mevcut tek parça PUT yolu kalır.
- **Temizlik:** yarıda bırakılan yüklemeler:
  - Günlük cron: 24 saatten eski `draft` postlar → `AbortMultipartUpload` +
    taslak silinir.
  - R2 bucket lifecycle kuralı: "tamamlanmamış çok parçalı yüklemeleri 1 gün
    sonra iptal et" (Cloudflare panelinden, elle — FAZLAR'a eklenecek).
- **Ekran:** yükleme sürerken `navigator.wakeLock.request("screen")`
  (iOS 16.4+ Safari; ana ekran PWA'sında daha yeni iOS gerekebilir —
  desteklenmiyorsa atlanır) ve "uygulamadan çıkma, çıkarsan döndüğünde devam
  eder" metni.

### 5.2 V7b doğrulama
1. Vitest: parça imzalama kapsamı (başka müşterinin postu → 404), `uploadId`
   istemciden alınmıyor, complete'te eksik/yanlış ETag → 400, 24 saatlik
   temizlik cron'u abort çağırıyor (R2 mock).
2. Gerçek iPhone: 100 MB+ video → yükleme %40'ta başka uygulamaya geç →
   30 sn sonra dön → devam ediyor, baştan başlamıyor. Uçak modu aç/kapat →
   son parçadan devam. Uygulamayı kapat → aynı videoyu yeniden seç → kaldığı
   yerden.
3. R2'de tamamlanan dosya `ffprobe` ile bozulmamış; kuyruk + caption normal.

## 6. V7c — Telefona bildirim (Web Push)

### 6.1 Tasarım
- **Koşullar (iOS):** iOS 16.4+, uygulama **ana ekrana eklenmiş** (Safari
  sekmesinde çalışmaz), izin **bir kullanıcı dokunuşuyla** istenir.
- **Anahtarlar:** VAPID çifti (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT=mailto:...`) — Vercel env; bir kez üretilir.
  Kütüphane: `web-push` (Node, Vercel fonksiyonunda çalışır).
- **Şema:** `PushSubscription { id, clientUserId, endpoint @unique, p256dh,
  auth, userAgent?, createdAt, lastSuccessAt?, failCount Int @default(0) }`.
- **Abonelik:** Ayarlar'da "Bildirimleri aç" (yalnızca standalone'da ve
  destek varsa görünür; Safari sekmesindeyse "önce ana ekrana ekle" notu) →
  `pushManager.subscribe` → `POST /api/portal/push` (kaydet, upsert by
  endpoint) / `DELETE` (kapat). Kontrol sırası CLAUDE.md'deki gibi.
- **Gönderim:** `src/lib/push.ts > notifyClientUsers(clientId, payload)` —
  **asla throw etmez** (`sendAlert` deseni); 404/410 → abonelik silinir;
  diğer hatalarda `failCount++`, 5'te silinir.
- **Hangi olaylar** (mevcut e-posta kancalarının yanına, e-posta KALIR — K4):
  | Olay | Kanca | Bildirim |
  |---|---|---|
  | Yayınlandı | `publish-post.ts` → `notifyPortalOutcome` | "Videon yayınlandı" → dokununca Instagram linki |
  | Yayınlanamadı | aynı yer | "Video yayınlanamadı: <kısa neden>" → video detayı |
  | Slot boş (onaylı yok) | `tick` → `notifySlotEmpty` | "Bu saatte onaylı video yoktu" → kuyruk |
  | Caption'lar hazır | `caption/run.ts` (ready) | **toplu:** "3 video onayına hazır" — video başına bildirim YOK (spam) |
  | Günlük hatırlatma | `queue-digest.ts` | "Yarın 19:00'da şu yayınlanacak" |
- **SW:** `push` → `showNotification(title, { body, data: { url } })`;
  `notificationclick` → ilgili portal sayfasını aç/odakla.
- **Caption hazır toplama:** her caption bitişinde değil; aynı müşteri için
  son 2 dakikada gönderilmişse atla (bellek/Redis tabanlı basit kısma).
  Kesin çözüm gerekirse `lastPushAt` alanı — V7c'de karar.

### 6.2 V7c doğrulama
1. Vitest: abonelik route'ları (IDOR, checkOrigin), `notifyClientUsers`
   410 → silme, throw etmeme, olay kancalarının çağrıldığı.
2. Gerçek iPhone (ana ekrandan açılmış): izin ver → test videosunu onayla →
   slot → "yayınlandı" bildirimi kilit ekranında → dokun → Instagram.
   Bildirimleri kapat → gelmiyor.

## 7. V7d — Android paylaşım hedefi

- Manifest `share_target`:
  `{ action: "/portal/paylas", method: "POST", enctype: "multipart/form-data",
  params: { files: [{ name: "video", accept: ["video/*"] }] } }`.
- POST'u **service worker yakalar** (sunucuya gitmez — Vercel 4.5 MB gövde
  sınırı), dosyayı geçici olarak Cache/IndexedDB'ye koyar ve
  `/portal/yukle?paylasim=1`'e yönlendirir; yükleme formu dosyayı oradan
  alıp normal (V7b) akışı başlatır.
- iPhone'da `share_target` desteklenmiyor — orada dosya seçici.
- **Doğrulama:** Android Chrome'da uygulamayı yükle → Galeri → video →
  Paylaş → uygulama → yükleme ekranı dosyayla açılır → yükle → kuyruk.

## 8. Bilinen iOS sınırları (kullanıcıya açıkça söylenecek)
- Yükleme **arka planda devam etmez**; uygulamaya dönünce kaldığı yerden
  sürer (V7b).
- Galeriden "Paylaş → uygulama" yok (V7d yalnızca Android).
- Bildirim için ana ekrana eklemek ve izin vermek şart.
- Uygulama adı/ikonu eklendiği anda kopyalanır; değişirse kullanıcının
  uygulamayı silip yeniden eklemesi gerekir.

## 9. Test ortamı notu
- Gerçek iPhone testi HTTPS ister: prod ya da Vercel preview.
- **R2 CORS preview adreslerini kapsamıyor** → preview'da yükleme testi için
  ya preview adresi CORS'a geçici eklenir ya da test prod'da yapılır. Karar
  uygulamada.
- Sayfaya özel ikon için kaynak görsel (1024 px kare) kullanıcıdan istenecek.

## 10. Uygulanınca güncellenecek belgeler
- `README.md`: §2 mimari (SW, push), §4 veri modeli (yeni alanlar/tablo),
  §6 e-postalar (+ bildirim sütunu), §7 portal (kurulum, kodla giriş,
  parçalı yükleme).
- `KARARLAR.md`: V7a–d sırasında verilen kararlar (ikon depolama yeri,
  push kısma yöntemi, preview CORS).
- `FAZLAR.md`: her alt faz ✅ + oturum devri.
