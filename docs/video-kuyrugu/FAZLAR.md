# Video kuyruğu — fazlar ve oturum devri

Tasarım: [`README.md`](README.md) · Kararlar: [`KARARLAR.md`](KARARLAR.md)

## Oturum devri

> Her oturum bu bölümü güncelleyerek biter. Yeni oturum buradan başlar.

- **Son güncelleme:** 2026-09-25
- **Son durum:** V0 (#59), V1 temeli (#60, #61), V2 caption (#62), V4 tick (#63), V3 portal (#65) merge edildi. Kod tarafı tamam; canlıya geçiş dış hesaplara bağlı.
- **Sıradaki adım:** V5 kalanı — Furkan'ın portal kullanıcısı (e-posta kullanıcıdan bekleniyor; `/clients` → "Portal erişimi"), Furkan portal ayarlarından yayın saatlerini seçer, ilk gerçek yükleme uçtan uca izlenir, bir hafta onay açık modda izleme.
- **Canlıda kurulu:** Vercel env (R2, QStash US, fal, Anthropic — Production + Preview), QStash schedule `scd_4rmi9RPUgv1uQkyzWBRwTagJEQQk` (`*/5 * * * *` → `POST /api/queue/tick`, ilk tick 200), Furkan'ın `captionStyle`'ı (`scripts/caption-stili-yukle.mjs`).
- **Dikkat:** Furkan'ın Instagram token'ı 2026-10-15'te bitiyor; yenileme cron'u 20 gün kala devreye girer — 2026-09-26 sabahı yenilendiğini kontrol et.
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
- **Kapsam:** QStash schedule, Furkan'ın kaydı ve ayarları, furi1'de Reels
  elle gönderim yolunun emekliye ayrıldığı notu, bir hafta onay açık modda
  izleme.
- **Kabul:** uçtan uca senaryo (README'deki doğrulama listesi) canlıda
  geçti; sonuç bu dosyaya yazıldı.

## Uçtan uca doğrulama senaryosu (V5)

1. Portaldan 3 video yükle → caption'lar birkaç dakikada hazır.
2. Sırayı değiştir.
3. Slotu 10 dk sonraya al:
   - onay açık, onaylı video yok → yayın yok, "onaylı video yok" e-postası;
   - bir videoyu onayla → sonraki slotta o yayınlanır, başarı e-postası.
4. Onayı kapat → sıradaki video kendiliğinden yayınlanır, e-posta gelir.
5. Hata yolu (test hesabında token'ı geçersiz kıl) → hata e-postası, video
   kuyrukta "hata" rozetiyle kalır.
