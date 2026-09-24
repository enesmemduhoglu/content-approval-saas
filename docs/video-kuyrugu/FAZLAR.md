# Video kuyruğu — fazlar ve oturum devri

Tasarım: [`README.md`](README.md) · Kararlar: [`KARARLAR.md`](KARARLAR.md)

## Oturum devri

> Her oturum bu bölümü güncelleyerek biter. Yeni oturum buradan başlar.

- **Son güncelleme:** 2026-09-25
- **Son durum:** V0 merge edildi (#59). V1 temeli (şema göçü, `storage-r2.ts`, `qstash.ts`, tüm yeni bağımlılıklar) `feat/v1-temeller`'de.
- **Sıradaki adım:** V1 kalanı + V4 (`queue.ts`, tick), V2 (caption) ve V3 (portal) paralel ajanlarla, ayrı worktree'lerde.
- **Yarım kalan:** —
- **Kullanıcıdan beklenen:** aşağıdaki "Elle yapılacaklar" listesi (hesap ve
  anahtarlar). Bunlar gelmeden V1'in dış doğrulamaları koşamaz; şema ve saf
  fonksiyonlar beklemeden ilerleyebilir.
- **Çalışma izni:** kullanıcı 2026-09-25'te fazlarda commit, PR ve merge
  için tam izin verdi. Şema göçü içeren PR'lar yine de `CLAUDE.md`'deki
  "Merge = prod şema göçü" kuralına göre sınanmadan merge edilmez.

## Elle yapılacaklar (repo yapamaz)

- [ ] **Cloudflare R2:** hesap, gizli bucket, yalnızca o bucket'a yetkili
      API token'ı → `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
      `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (Vercel + `.env.local`).
      Bucket CORS: portal alan adı + `http://localhost:3000`, `PUT`/`GET`.
- [ ] **Upstash QStash:** `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
      `QSTASH_NEXT_SIGNING_KEY` (Vercel + `.env.local`).
- [ ] **fal.ai:** `FAL_KEY` (subtitle-pipeline'daki anahtar kullanılabilir).
- [ ] **Anthropic:** `ANTHROPIC_API_KEY`.
- [ ] **V5'te:** QStash schedule (`*/5 * * * *` → `/api/queue/tick`), Furkan'ın
      `ClientUser` kaydı ve `PublishSettings`'i.

## Fazlar

Durum: ⬜ başlamadı · 🟡 sürüyor · ✅ bitti. Her faz `core:faz` akışıyla:
branch → PR → bu dosyanın güncellenmesi.

### V0 — Belgeler ✅
- **Kapsam:** `docs/video-kuyrugu/` (bu dört dosya), `CLAUDE.md` ve
  `TODOS.md`'ye işaretçi. Kod değişikliği yok.
- **Kabul:** yeni bir oturum yalnızca bu klasörü okuyarak işe başlayabiliyor.
- **PR:** `feat/video-kuyrugu-belgeler`

### V1 — Doğrulama ve temeller 🟡
- **Yapıldı (`feat/v1-temeller`):** şema göçü `20260925120000_video_kuyrugu` (yalnızca ekleme; eski veri üzerinde sınandı, drift yok), `storage-r2.ts`, `qstash.ts` + testleri, müşteri silme yolunun yeni tabloları temizlemesi, V2–V4'ün tüm npm bağımlılıkları (lock çakışması olmasın diye tek seferde).
- **Kalan:** `queue.ts` (V4 ajanına), dış doğrulamalar (anahtarlar bekleniyor).
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

### V2 — Caption üretimi ⬜
- **Kapsam:** `src/lib/caption/{transcribe,generate,validate}.ts`,
  `src/lib/qstash.ts` (imza doğrulama + mesaj yayınlama),
  `POST /api/queue/caption/[postId]`. `caption-stili.md` → Furkan'ın
  `captionStyle` alanı.
- **Kabul:** imzasız istek 401; doğrulama sınırları testli; dış servisler
  mock'lu testte `ready`/`failed` geçişleri doğru; mevcut videolarla elle
  deneme sonucu bu dosyaya not.

### V3 — Müşteri portalı ⬜
- **Kapsam:** magic-link girişi (`src/lib/client-auth.ts`), müşteri kapsamlı
  `getScopedDb` varyantı, `/api/portal/*` route'ları (`nextjs-prisma:route-ekle`),
  `/portal` sayfaları: yükle (tarayıcıda kare çıkarma), kuyruk (sürükle-bırak),
  detay (caption düzenle / yeniden üret / onay), geçmiş, ayarlar.
- **Kabul:** IDOR testleri (A, B'nin kuyruğunu göremez/taşıyamaz/imzalı URL
  alamaz); `checkOrigin` + rate limit; UI testleri; elle yükleme denemesi.

### V4 — Yayın tick'i ve e-postalar ⬜
- **Kapsam:** `POST /api/queue/tick`, `SlotRun` idempotency, onay modları,
  `auto_approved` audit, tick içinde Reels'in tamamlanması, portal postunun
  onay yolunda anında yayınlanmaması, tüm e-postalar (README §6).
- **Kabul:** iki eşzamanlı tick → tek yayın; onay açıkken onaysız video
  asla yayınlanmıyor (ayrı test); hata kuyruğu durdurmuyor; e-posta
  şablonları testli.

### V5 — Canlıya geçiş ⬜
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
