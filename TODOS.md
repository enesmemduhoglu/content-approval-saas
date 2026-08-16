# TODOS

Plan review'da (D3/D4 kararları) v1 kapsamı dışına ertelenen işler — v2'de kapatıldı:

- [x] **Çoklu görsel / carousel desteği (D3.3)** — 2026-07-22: `PostImage` tablosu (veri taşıma migration'ıyla), post başına 10 görsele kadar yükleme, onay sayfasında scroll-snap carousel, dashboard'da adet rozeti.
- [x] **Ajans markalama (D3.4)** — 2026-07-22: `/settings` sayfasından logo + marka rengi; onay sayfası ve e-postada uygulanıyor (hex doğrulamalı, injection korumalı).
- [x] **Toplu onay** — 2026-07-22: onay sayfası aynı müşterinin bekleyen diğer postlarını listeler; "Tümünü onayla" tek istekte post başına audit kaydıyla onaylar.
- [x] **Upstash Redis rate limiting (D4)** — 2026-07-22: `checkRateLimit` Upstash REST env değişkenleri varsa dağıtık sayaç kullanır, yoksa/hatada in-memory fallback. Not: Vercel'de Upstash entegrasyonunun kurulup env değişkenlerinin eklenmesi gerekir; eklenene kadar in-memory davranış sürer.
- [x] **Vercel Blob + Resend production kurulumu (T7)** — 2026-07-22 tamamlandı: Blob store `content-approval-images` canlıda, Resend `enesmemduhoglu.tech` doğrulanmış domain'iyle (SPF/DKIM/DMARC) gönderiyor.

## Yeni ertelenenler

- [ ] **Toplu reddetme** — bilinçli kapsam dışı: reddetme sebebi post başına anlamlı olduğu için toplu onayın simetriği yapılmadı.

## Instagram yayını sonrası (2026-08-16)

Instagram yayını PR #12 + #13 ile canlıya alındı (onay→yayın prod'da 11.29 sn ölçüldü).
Aşağıdakiler bilinçli olarak o kapsamın dışında bırakıldı, ayrı bir oturumda yapılacak.

- [x] **Token süresi uyarısı** — 2026-08-16: dashboard'da proaktif uyarı şeridi.
      `src/lib/instagram-token.ts` tek doğruluk kaynağı (`IG_TOKEN_WARNING_DAYS = 10`);
      `publish-post.ts`'deki süre kontrolü de aynı yardımcıyı kullanıyor. Şerit iki tonlu:
      "yakında doluyor" (sarı) ve "doldu → yayın durmuş" (kırmızı, `role="alert"`).
      Token'ın kendisi `select` edilmiyor, prop'a da girmiyor — yalnızca ad + kalan gün.
      Mevcut prod token'ı **2026-10-15**'te doluyor, yani uyarı 2026-10-05'te çıkacak.
      *Hâlâ açık:* otomatik yenileme yok. `GET /refresh_access_token` çağrısını bir cron'a
      bağlayıp `instagramTokenExpiry`'yi güncellemek ayrı iş (furi'deki `scripts/ig_token.py`
      örnek). Bugün ajans uyarıyı görüp token'ı elle yenilemek zorunda.

- [x] **Prod'daki test kayıtlarını temizle** — 2026-08-16 tamamlandı. `Client`
      `testclientnoig0000000000000000` ve ona bağlı post, doğru sırada (`ApprovalAudit`,
      `ApprovalLink`, `PostImage`, `Post`, `Client`) tek transaction içinde silindi.
      "Duman testi" postunun 404 veren `igPermalink`'i `NULL`'landı; `publishStatus` ve
      `igMediaId` bilinçli olarak korundu (post gerçekten yayınlanmıştı).
      **Dikkat — `.env.local` tuzağı:** `DATABASE_URL` **localhost**'a (Docker) bakıyor,
      prod Neon adresi **`POSTGRES_URL`** altında. Prisma varsayılanıyla bağlanan bir betik
      prod'a değil yerel DB'ye düşer. Prod'a yazmadan önce bağlandığın hostu doğrula.

- [x] **Toplu onay yayın yapmıyor** — 2026-08-16: yayın hedefi olan postlar toplu onaydan
      çıkarıldı. Instagram bağlı müşteride `POST /api/approve/[token]/batch` hiçbir postu
      onaylamıyor (409 + "tek tek onaylaman gerekiyor"), onay sayfasında "Tümünü onayla"
      butonu yerine sebebini anlatan açıklama çıkıyor, panelde onaylanmış ama yayınlanmamış
      postlar "Yayınlanmadı" rozetiyle görünüyor. Toplu yayın bilinçli olarak yapılmadı:
      slayt container'ı başına ~8.5 sn, 60 sn Vercel tavanı.
      Bu durumda sıkışmış eski postlar onay linkindeki "Instagram'a yayınla" butonuyla
      kurtarılabiliyor (karar yeniden verilmiyor, yalnızca yayın çalışıyor).
      *Kalan elle iş:* prod panelinde "Yayınlanmadı" rozetli post varsa linki müşteriye
      gönderilip yayınlanmalı.

- [x] **Instagram bağlama arayüzü** — 2026-08-16: `/clients` sayfasındaki her müşteri satırında
      bağlama alanı var (`POST`/`DELETE /api/clients/[id]/instagram`). Token `type="password"`
      ile girilir, `GET /me?fields=user_id` ile doğrulanıp `instagramUserId` otomatik doldurulur.
      Client okumaları artık `ClientView` döner — `instagramAccessToken` hiçbir yanıtta ham
      geçmez, yerine "bağlı mı" + son 4 karakterlik ipucu çıkar.
      *Not:* `GET /api/clients` token'ı bu değişikliğe kadar ham dönüyordu, kapandı.

## Prod temizliği sırasında fark edilenler (2026-08-16)

- [ ] **Aynı içerik Instagram'a iki kez yayınlanmış** — `externalRef='dizi/long-story-short'`
      iki ayrı posta bağlı ve **ikisi de** `publishStatus='published'`, farklı permalink'lerle:
      `cmsvyzi1w0001ju04qoih8gjp` (15:38) ve `cmsw1t4mv0001ky046csgssb5` (16:57).
      `externalRef` üzerinde mükerrer yayın koruması yok görünüyor — furi tarafı aynı içeriği
      iki kez gönderirse Instagram'a iki kez düşüyor. *Yapılacak:* `externalRef` için
      benzersizlik kısıtı ya da yayın öncesi "bu ref zaten yayınlanmış mı" kontrolü.

- [ ] **22 Temmuz'dan kalma çöp veri** — `Enes Memduh` / `enes can` ajansları altında
      `"asd"`, `"gfh"`, `"as"`, `"sdf"` başlıklı 6 test postu duruyor. Zararsız ama prod'u
      kirletiyor. Bu turda bilinçli olarak kapsam dışı bırakıldı.

### Bu listede olmayan, ayrı repo

`furi` tarafındaki Faz 2 değişikliği (SKILL.md'nin SaaS'a POST atması, Gmail/apps-script
zincirinin emekliye ayrılması) yapılmadı. Uçtan uca otomasyon ancak o repo güncellenince tamamlanır.
