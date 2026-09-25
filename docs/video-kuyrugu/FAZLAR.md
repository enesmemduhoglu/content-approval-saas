# Video kuyruğu — fazlar ve oturum devri

Tasarım: [`README.md`](README.md) · Kararlar: [`KARARLAR.md`](KARARLAR.md)

## Oturum devri

> Her oturum bu bölümü güncelleyerek biter. Yeni oturum buradan başlar.

- **Son güncelleme:** 2026-09-25
- **Son durum:** V0–V4 merge edildi (#59–#65), dış doğrulamalar tamam (#67, #68), **V5 canlıda.** İlk gerçek yayın 2026-09-25 03:10 (onaylı video, slot 03:09 → Reels ~20 sn'de yayında); 03:13 boş slotu `empty` + "onaylı video yok" e-postası (Resend kabul etti, log temiz). Yayınlanan video dikey çıktı → V6.
- **V6 iptal (K24):** video telefonda hazırlanıp yüklenecek; portal videoya dokunmaz.
- **Sıradaki iş: V7 (PWA)** — [`V7-pwa.md`](V7-pwa.md), sıra V7a → V7b → V7c → V7d. Kullanıcı 2026-09-25'te "şimdi halledeceğiz" dedi.
- **Sıradaki adım:** V5 kalanı — Furkan'ın portal e-postası (kullanıcıdan bekleniyor) eklenip test kullanıcısı kaldırılır; Furkan gerçek yayın saatlerini seçer; bir hafta onay açık modda izleme. Sonra V6/V7 (kullanıcı başlatınca).
- **Açık durumlar (prod):** portalın tek kullanıcısı test için `eneshan034@gmail.com` (Furkan'ın müşteri kaydında); `PublishSettings.slots = ["03:13"]` hâlâ ayarlı olabilir — her gece boş slot e-postası üretir, kullanıcıya duraklatması söylendi; kuyrukta 2 onaysız test videosu.
- **Canlıda kurulu:** Vercel env (R2, QStash US, fal, Anthropic — Production + Preview), QStash schedule `scd_4rmi9RPUgv1uQkyzWBRwTagJEQQk` (`*/5 * * * *` → `POST /api/queue/tick`, ilk tick 200), Furkan'ın `captionStyle`'ı (`scripts/caption-stili-yukle.mjs`).
- **Dikkat:** Furkan'ın Instagram token'ı 2026-10-15'te bitiyor; yenileme cron'u 20 gün kala devreye girer — 2026-09-26 sabahı yenilendiğini kontrol et.
- **V8 (yayın günleri, K28):** #77 merge edildi. Furkan Ayarlar'dan günleri seçer.
- **iPhone denemesi (2026-09-25, kullanıcı):** portal açılıyor, çoğu şey çalışıyor,
  video yüklendi; yüklenen videonun yayını telefondan henüz denenmedi.
- **Portal hızı + seçince yükle (`perf/portal-iskelet`):** ölçüm (Türkiye → iad1,
  sıcak): sayfa yanıtları 200–300 ms, bunun ~130 ms'i ağ; DB (Neon us-east-1)
  Vercel'le aynı bölgede, sorgular paralel, JS ~100 kB — sunucu darboğaz değil.
  Asıl sorun sekmeye dokununca yanıt gelene kadar ekranın hiç değişmemesiydi
  (`loading.tsx` yoktu) → `app/portal/loading.tsx` iskeleti eklendi. Yükle
  ekranında "Videoyu yükle" düğmesi kalktı: galeriden seçim yüklemeyi hemen
  başlatır. Soğuk başlangıç ölçülemedi (Vercel log erişimi yok). Aynı PR'da
  kullanıcı isteğiyle sadeleştirme: Ayarlar'daki "Uygulama" kartı (ana ekrana
  ekli / sürüm) kalktı, yalnızca "Çıkış yap" kaldı (yeni sürümü `UpdateBand`
  zaten söylüyor); saat dilimi seçicisi kalktı, kayıt hep `Europe/Istanbul`
  gönderir; Kuyruk başlığındaki sağ üst Ayarlar düğmesi kalktı (alt çubukta var).
- **Müşteriye iPhone kurulum rehberi** yazıldı (sohbette kullanıcıya verildi).
  Göndermeden önce: Furkan'ın `ClientUser` kaydı, `Client.app*` alanları ve
  Vercel'de `VAPID_*` env'i doğrulanmalı.
- **Yarım kalan:** —
- **Kullanıcıdan beklenen:** aşağıdaki "Elle yapılacaklar" listesi (hesap ve
  anahtarlar). Bunlar gelmeden V1'in dış doğrulamaları koşamaz; şema ve saf
  fonksiyonlar beklemeden ilerleyebilir.
- **Çalışma izni:** kullanıcı 2026-09-25'te fazlarda commit, PR ve merge
  için tam izin verdi. Şema göçü içeren PR'lar yine de `CLAUDE.md`'deki
  "Merge = prod şema göçü" kuralına göre sınanmadan merge edilmez.

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
- [ ] **Furkan'ın `ClientUser` kaydı** (`/clients` → "Portal erişimi") ve
      portal ayarlarından yayın saatleri (`PublishSettings`).

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

### V5 — Canlıya geçiş 🟡
- **Canlı test (2026-09-25):** 3 video yüklendi, üçünün caption'ı dakikalar içinde `ready`; onaylı olan 03:09 slotunda yayınlandı (container aynı tick'te `FINISHED`, tek sonuç e-postası), onaysız ikisi kuyrukta kaldı; 03:13 slotu onaylı video olmadığı için `empty` + e-posta. E-posta Gmail'de spam'e düşebilir — kullanıcıya "Spam değil" dedirt.
- **Kapsam:** QStash schedule, Furkan'ın kaydı ve ayarları, furi1'de Reels
  elle gönderim yolunun emekliye ayrıldığı notu, bir hafta onay açık modda
  izleme.
- **Kabul:** uçtan uca senaryo (README'deki doğrulama listesi) canlıda
  geçti; sonuç bu dosyaya yazıldı.

### V6 — Yüklemede 1:1 kare kırpma ❌ İPTAL
- **Belge:** [`V6-kare-kirpma.md`](V6-kare-kirpma.md) (tarihsel) · Kararlar: K22 → K24.

### V7 — PWA (telefonda uygulama olarak) — belge: [`V7-pwa.md`](V7-pwa.md) · K23, K25
Öncelikli cihaz iPhone; ad/ikon sayfaya özel.
- **V7a — Kurulum + kodla giriş + mobil arayüz 🟡** — altyapı ✅ (#72: dinamik
  manifest, iOS meta, SW + çevrimdışı sayfa, 6 haneli kodla giriş, kaydırmalı
  oturum, 67 yeni test); ikon ✅ (Furkan'ın kendi illüstrasyonu, K27); kalan:
  mobil arayüzün tasarımdan koda dökülmesi (tasarım:
  https://claude.ai/artifact/WUckhyutaTLTtwo7V5CpYC), kurulum rehberi bandı,
  yeni sürüm bandı, Furkan'ın `app*` alanları.
  Özgün plan: — dinamik manifest,
  ikonlar, viewport/güvenli alan, 6 haneli kodla giriş, kaydırmalı oturum,
  alt sekme çubuğu, iOS kurulum rehberi, en küçük service worker. Şema:
  `Client.app*`, `ClientLoginToken.codeHash/attempts`. Kabul: §4.7.
- **V7b — Dayanıklı yükleme ✅ (#71)** — 8 MB parçalı, kaldığı yerden devam,
  IndexedDB, wakeLock, 24 saatlik taslak temizliği (günlük cron). Gerçek R2'de
  denendi; gerçek iPhone testi bekliyor. R2 lifecycle kuralı kuruldu
  (2026-09-25): tamamlanmamış çok parçalı yüklemeler **2 gün** sonra iptal —
  günlük cron 24 saatte temizliyor, kural ikinci güvenlik ağı. Özgün plan: — R2 çok parçalı, kaldığı yerden devam,
  IndexedDB ilerleme, wakeLock, yarım yükleme temizliği. Şema:
  `Post.uploadId`. Kabul: §5.2.
- **V7c — Bildirimler (Web Push) ⬜** — VAPID, `PushSubscription` tablosu,
  yayın/hata/boş slot/caption hazır/günlük hatırlatma bildirimleri; e-posta
  yedek. Kabul: §6.2.
- **V7d — Android paylaşım hedefi ⏸ ERTELENDİ (2026-09-25)** — `share_target` + SW.
  Kullanıcı kararı: bekletilecek. Furkan iPhone kullanıyor ve iOS PWA paylaşım
  hedefini desteklemiyor; Android kullanan bir müşteri gelince ele alınır
  (~yarım gün). Kabul: §7.

### V8 — Yayın günleri ✅ (#77, merge bekliyor) — belge: [`V8-yayin-gunleri.md`](V8-yayin-gunleri.md) · K28
Haftanın hangi günleri yayın olacağı (tek gün kümesi × tek saat listesi).
Göç `20260926130000_yayin_gunleri` (`PublishSettings.days`, varsayılan tüm
günler; eski veriyle sınandı), `slotInstants` yerel gün filtresi, ayar
doğrulaması (`field: "days"`, alan yoksa korunur), Ayarlar'da "Yayın günleri
ve saatleri" kartı (gün çipleri, hazır seçimler, canlı özet + sıradaki 3
yayın), kuyrukta "Perşembe · 19:00". Merge = prod göçü (toplayıcı; Furkan'ın
ayarı "her gün" kalır, günleri portaldan kendisi seçer).

## Uçtan uca doğrulama senaryosu (V5)

1. Portaldan 3 video yükle → caption'lar birkaç dakikada hazır.
2. Sırayı değiştir.
3. Slotu 10 dk sonraya al:
   - onay açık, onaylı video yok → yayın yok, "onaylı video yok" e-postası;
   - bir videoyu onayla → sonraki slotta o yayınlanır, başarı e-postası.
4. Onayı kapat → sıradaki video kendiliğinden yayınlanır, e-posta gelir.
5. Hata yolu (test hesabında token'ı geçersiz kıl) → hata e-postası, video
   kuyrukta "hata" rozetiyle kalır.
