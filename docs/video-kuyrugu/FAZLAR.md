# Video kuyruğu — fazlar ve oturum devri

Tasarım: [`README.md`](README.md) · Kararlar: [`KARARLAR.md`](KARARLAR.md)

## Oturum devri

> Her oturum bu bölümü güncelleyerek biter. Yeni oturum buradan başlar.
> Yalnızca GÜNCEL durum yazılır; kapanmış işlerin ayrıntısı PR'larda ve git geçmişinde.

- **Son güncelleme:** 2026-09-28 (V9 — R2 depolama temizliği, #84 açık)
- **Canlı durum:** V0–V5, V7a/b/c ve V8 canlıda; #83 (portal analiz iyileştirmeleri +
  bu belge turu, göç `20260928100000_kaynak_dosya`) merge edildi. Furkan portalı
  iPhone'unda PWA olarak kullanıyor, kendi yayın gün/saatlerini seçti, yayın açık.
  Test dönemi kalıntıları (test portal kullanıcısı, yedek e-posta, duraklatılmış tek
  slot, test Reels'leri) artık yok — kullanıcı beyanı, 2026-09-28. Kapak düzeltmesinin
  (#81) iPhone'dan yükleme denemesi kullanıcı tarafından yapıldı.
- **V9 (#84) merge bekliyor — şema göçü var** (`outsideAt`, toplayıcı; eski veriyle
  sınandı). Merge kullanıcıda. Merge sonrası: (1) bir saat içinde tick yanıtında
  `retention` sayıları görünmeli; (2) kullanıcı `node scripts/r2-denetim.mjs` ile
  bucket boyutunu ve sahipsiz nesneleri kontrol eder (prod okuması — komut
  kullanıcıya verilir); (3) portalda kuyruk dışı kartlarda sayaç görünür.
  Platform sorusu (2026-09-28): Vercel'de kalınıyor — video baytları Vercel'den
  geçmiyor, Hobby kota aşımında fatura çıkarmaz; Cloudflare'e taşımanın kazancı
  yok. Furkan ücretli müşteriye dönüşürse Hobby'nin ticari kullanım koşulu ayrıca
  ele alınır.
- **Sıradaki işler:** `TODOS.md` → "Video kuyruğu" bölümü (küçük kapak, V7c canlı
  doğrulaması, K17 özet tekrar koruması, K15 altText, V7d ertelendi). Kullanıcı
  2026-09-28'de başka bir işe geçti; bunlar kullanıcı başlatınca.
- **Dikkat:** Furkan'ın Instagram token'ı 2026-11-24'te bitiyor; yenileme cron'u 20 gün
  kala (~2026-11-04) devreye girer — o hafta yenilendiğini kontrol et.
- **Canlıda kurulu:** Vercel env (R2, QStash US, fal, Anthropic — Production + Preview),
  QStash schedule (`*/5 * * * *` → `POST /api/queue/tick`), R2 CORS + lifecycle (yarım
  çok parçalı yükleme 2 gün sonra iptal), Furkan'ın `captionStyle`'ı ve `Client.app*`
  alanları.
- **Prod okuma/merge:** Claude Code'un otomatik izin denetimi prod DB okumayı ve
  incelemesiz merge'ü engelleyebiliyor. Yeni oturumlar merge'den önce kullanıcıya
  sorar; şema göçü içeren PR `CLAUDE.md`'deki "Merge = prod şema göçü" kuralıyla
  sınanmadan merge edilmez.

## Elle yapılacaklar (repo yapamaz)

- [x] **Cloudflare R2:** (2026-09-25, yerel + Vercel) hesap, gizli bucket, yalnızca o bucket'a yetkili
      API token'ı → `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
      `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (Vercel + `.env.local`).
      Bucket CORS: portal alan adı + `http://localhost:3000`, `PUT`/`GET`.
- [x] **Upstash QStash (US bölgesi):** `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
      `QSTASH_NEXT_SIGNING_KEY` (Vercel + `.env.local`).
- [x] **fal.ai:** `FAL_KEY` (subtitle-pipeline'daki anahtar kullanılabilir).
- [x] **Anthropic:** `ANTHROPIC_API_KEY`. (Vercel'e eklendiği kullanıcı beyanı; deploy sonrası doğrulanacak.)
- [x] **QStash schedule** (`*/5 * * * *` → `/api/queue/tick`) — 2026-09-25.
- [x] **Furkan'ın `ClientUser` kaydı** ve portal ayarlarından yayın gün/saatleri
      (`PublishSettings`) — 2026-09-25 / 28.

## Fazlar

Durum: ⬜ başlamadı · 🟡 sürüyor · ✅ bitti. Her faz `core:faz` akışıyla:
branch → PR → bu dosyanın güncellenmesi.

### V0 — Belgeler ✅
- **Kapsam:** `docs/video-kuyrugu/` (bu dört dosya), `CLAUDE.md` ve
  `TODOS.md`'ye işaretçi. Kod değişikliği yok.
- **Kabul:** yeni bir oturum yalnızca bu klasörü okuyarak işe başlayabiliyor.
- **PR:** `feat/video-kuyrugu-belgeler`

### V1 — Doğrulama ve temeller ✅
- **Yapıldı (`feat/v1-temeller`):** şema göçü `20260925120000_video_kuyrugu` (yalnızca ekleme; eski veri üzerinde sınandı, drift yok), `storage-r2.ts`, `qstash.ts` + testleri, müşteri silme yolunun yeni tabloları temizlemesi, V2–V4'ün tüm npm bağımlılıkları (lock çakışması olmasın diye tek seferde).
- **Dış doğrulamalar tamam:** R2 (imzalı PUT/GET, CORS, gizli bucket), fal ← R2 URL, Instagram ← R2 URL (container FINISHED, yayınsız), QStash imzası prod'da (K14b, K20, K21).
- **Kapsam:**
  - Dış doğrulamalar (anahtarlar gelince; sonuçlar `KARARLAR.md`'ye):
    fal Whisper R2 imzalı mp4 URL'ini kabul ediyor mu; Instagram imzalı
    URL'den Reels konteyneri kurabiliyor mu; QStash ücretsiz kotası.
  - Şema göçü (`nextjs-prisma:goc`): `Post` alanları, `PublishSettings`,
    `SlotRun`, `ClientUser`, `ClientLoginToken`, `Client.captionStyle`.
  - `src/lib/queue.ts`: `dueSlots`, `pickNext`, `positionBetween` + testleri.
  - `src/lib/storage-r2.ts`: imzalı PUT/GET, `HeadObject`; env yoksa açık hata.
- **Kabul:** göç boş DB'de ve prod benzeri veride sorunsuz; `queue.ts`
  testleri saat dilimi, gün dönümü, kaçırılmış slot, duraklatma, onay
  modlarını kapsıyor; `tsc` + tüm testler yeşil.

### V2 — Caption üretimi ✅ (#62)
- **Sonuç:** `src/lib/caption/{transcribe,generate,validate,run,errors}.ts`, `POST /api/queue/caption/[postId]`, `scripts/caption-dene.ts`. 53 yeni test. Gerçek videoyla denendi (K14–K16).
- **Açık:** altText saklanmıyor (K15).
- **Kapsam:** `src/lib/caption/{transcribe,generate,validate}.ts`,
  `src/lib/qstash.ts` (imza doğrulama + mesaj yayınlama),
  `POST /api/queue/caption/[postId]`. `caption-stili.md` → Furkan'ın
  `captionStyle` alanı.
- **Kabul:** imzasız istek 401; doğrulama sınırları testli; dış servisler
  mock'lu testte `ready`/`failed` geçişleri doğru; mevcut videolarla elle
  deneme sonucu bu dosyaya not.

### V3 — Müşteri portalı ✅ (#65)
- **Sonuç:** magic-link girişi (`client-auth.ts`, HMAC çerez, her istekte DB doğrulaması), `client-scoped-db.ts`, `/api/portal/**`, `/portal/**` (yükleme + tarayıcıda kare, sürükle-bırak kuyruk, tahmini yayın zamanı, detay, geçmiş, ayarlar), `/clients`'ta "Portal erişimi", CSP'ye R2. ~170 yeni test (IDOR her route için). Kararlar K19.
- **Kapsam:** magic-link girişi (`src/lib/client-auth.ts`), müşteri kapsamlı
  `getScopedDb` varyantı, `/api/portal/*` route'ları (`nextjs-prisma:route-ekle`),
  `/portal` sayfaları: yükle (tarayıcıda kare çıkarma), kuyruk (sürükle-bırak),
  detay (caption düzenle / yeniden üret / onay), geçmiş, ayarlar.
- **Kabul:** IDOR testleri (A, B'nin kuyruğunu göremez/taşıyamaz/imzalı URL
  alamaz); `checkOrigin` + rate limit; UI testleri; elle yükleme denemesi.

### V4 — Yayın tick'i ve e-postalar ✅ (#63)
- **Sonuç:** `src/lib/queue.ts` (saf kurallar, DST testli), `queue-db.ts`, `POST|GET /api/queue/tick`, `publish-post.ts` onay koruması + R2 imzalı video URL'i + tek seferlik sonuç e-postası, `email-queue.ts`, `queue-digest.ts` (günlük cron'dan). 106 yeni test.
- **Açık:** günlük özetin tekrar koruması yalnızca süreç içinde (K17).
- **Kapsam:** `POST /api/queue/tick`, `SlotRun` idempotency, onay modları,
  `auto_approved` audit, tick içinde Reels'in tamamlanması, portal postunun
  onay yolunda anında yayınlanmaması, tüm e-postalar (README §6).
- **Kabul:** iki eşzamanlı tick → tek yayın; onay açıkken onaysız video
  asla yayınlanmıyor (ayrı test); hata kuyruğu durdurmuyor; e-posta
  şablonları testli.

### V5 — Canlıya geçiş ✅
- **Canlı test (2026-09-25):** 3 video yüklendi, üçünün caption'ı dakikalar içinde `ready`; onaylı olan 03:09 slotunda yayınlandı (container aynı tick'te `FINISHED`, tek sonuç e-postası), onaysız ikisi kuyrukta kaldı; 03:13 slotu onaylı video olmadığı için `empty` + e-posta. E-posta Gmail'de spam'e düşebilir — kullanıcıya "Spam değil" dedirt.
- **Kapsam:** QStash schedule, Furkan'ın kaydı ve ayarları, furi1'de Reels
  elle gönderim yolunun emekliye ayrıldığı notu, bir hafta onay açık modda
  izleme.
- **Kabul:** uçtan uca senaryo (README'deki doğrulama listesi) canlıda
  geçti; sonuç bu dosyaya yazıldı.
- **Kapanış (2026-09-28):** Furkan gerçek kullanıcı olarak portalda, gerçek yayın
  saatleriyle yayın açık; test kullanıcısı ve test verisi temizlendi.

### V6 — Yüklemede 1:1 kare kırpma ❌ İPTAL
- **Belge:** [`V6-kare-kirpma.md`](V6-kare-kirpma.md) (tarihsel) · Kararlar: K22 → K24.

### V7 — PWA (telefonda uygulama olarak) — belge: [`V7-pwa.md`](V7-pwa.md) · K23, K25
Öncelikli cihaz iPhone; ad/ikon sayfaya özel.
- **V7a — Kurulum + kodla giriş + mobil arayüz ✅** — altyapı (#72: dinamik
  manifest, iOS meta, SW + çevrimdışı sayfa, 6 haneli kodla giriş, kaydırmalı
  oturum); ikon (Furkan'ın kendi illüstrasyonu, K27); mobil arayüz, iOS kurulum
  bandı ve yeni sürüm bandı (#75); Furkan'ın `app*` alanları dolu, iPhone'da kurulu.
  Android'e özel "Uygulamayı yükle" (`beforeinstallprompt`) V7d'ye taşındı.
- **V7b — Dayanıklı yükleme ✅ (#71)** — 8 MB parçalı, kaldığı yerden devam,
  IndexedDB, wakeLock, 24 saatlik taslak temizliği (günlük cron). Gerçek R2'de
  denendi; gerçek iPhone testi bekliyor. R2 lifecycle kuralı kuruldu
  (2026-09-25): tamamlanmamış çok parçalı yüklemeler **2 gün** sonra iptal —
  günlük cron 24 saatte temizliyor, kural ikinci güvenlik ağı. Özgün plan: — R2 çok parçalı, kaldığı yerden devam,
  IndexedDB ilerleme, wakeLock, yarım yükleme temizliği. Şema:
  `Post.uploadId`. Kabul: §5.2.
- **V7c — Bildirimler (Web Push) ✅ (#74)** — VAPID, `PushSubscription` tablosu,
  yayın/hata/boş slot/caption hazır/günlük hatırlatma bildirimleri; e-posta yedek.
  Kalan canlı doğrulama (VAPID env'i + iPhone'da kilit ekranı bildirimi) `TODOS.md`'de.
- **V7d — Android paylaşım hedefi + yükleme düğmesi ⏸ ERTELENDİ (2026-09-25)** — `share_target` + SW, `beforeinstallprompt`.
  Kullanıcı kararı: bekletilecek. Furkan iPhone kullanıyor ve iOS PWA paylaşım
  hedefini desteklemiyor; Android kullanan bir müşteri gelince ele alınır
  (~yarım gün). Kabul: §7.

### V8 — Yayın günleri ✅ (#77) — belge: [`V8-yayin-gunleri.md`](V8-yayin-gunleri.md) · K28
Haftanın hangi günleri yayın olacağı (tek gün kümesi × tek saat listesi).
Göç `20260926130000_yayin_gunleri` (`PublishSettings.days`, varsayılan tüm
günler; eski veriyle sınandı), `slotInstants` yerel gün filtresi, ayar
doğrulaması (`field: "days"`, alan yoksa korunur), Ayarlar'da "Yayın günleri
ve saatleri" kartı (gün çipleri, hazır seçimler, canlı özet + sıradaki 3
yayın), kuyrukta "Perşembe · 19:00". Merge = prod göçü (toplayıcı; Furkan'ın
ayarı "her gün" kalır, günleri portaldan kendisi seçer).

### V9 — R2 depolama temizliği 🟡 (#84, merge bekliyor) · K30
Yayınlanan videonun mp4'ü + 5 karesi yayından 2 gün sonra silinir, kapak
(ilk kare) kalır; kuyruk dışı (reddedilen/çıkarılan) video 3 gün sonra
tamamen silinir. `src/lib/retention-rules.ts` (saf kurallar + metinler),
`src/lib/media-retention.ts` (iş; saatte bir tick, günlük cron emniyet ağı),
`src/lib/r2-cleanup.ts` (`deleteOwnedObjects`, portal silme + panel silme +
temizlik ortak), göç `20260928140000_kuyruk_disi_zamani` (`Post.outsideAt`,
toplayıcı; kuyruk dışındakilere `NOW()` backfill — eski veriyle sınandı).
Portal: kuyruk dışı kartta ve detayda kum saatli sayaç, geçmişte "Video N gün
daha burada", arşivlenen yayının detayında kapak + "Video artık Instagram'da".
Ajans panelinden silinen portal postunun R2 nesneleri de silinir.
`scripts/r2-denetim.mjs`: kullanım + sahipsiz nesne raporu (`--sil` ile siler).
Tasarım: V7 kanvası "Güncelleme 28 Eyl (4)".

## Uçtan uca doğrulama senaryosu (V5)

1. Portaldan 3 video yükle → caption'lar birkaç dakikada hazır.
2. Sırayı değiştir.
3. Slotu 10 dk sonraya al:
   - onay açık, onaylı video yok → yayın yok, "onaylı video yok" e-postası;
   - bir videoyu onayla → sonraki slotta o yayınlanır, başarı e-postası.
4. Onayı kapat → sıradaki video kendiliğinden yayınlanır, e-posta gelir.
5. Hata yolu (test hesabında token'ı geçersiz kıl) → hata e-postası, video
   kuyrukta "hata" rozetiyle kalır.
