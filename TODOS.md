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

- [ ] **Token süresi uyarısı** — `Client.instagramTokenExpiry` alanı dolu ama hiçbir yerde
      gösterilmiyor; token dolduğunda yayın sessizce durur (`publishStatus='failed'`,
      `publishError`'da "süresi dolmuş" yazar ama ajans bunu ancak bir post patlayınca görür).
      Mevcut prod token'ı **2026-10-15**'te doluyor.
      *Yapılacak:* dashboard'da son 10 güne girmiş müşteriler için uyarı şeridi.
      `src/lib/publish-post.ts`'de süre dolmuşsa hızlı hata zaten var, eksik olan proaktif uyarı.
      Yenileme çağrısı: `GET /refresh_access_token` (furi'deki `scripts/ig_token.py` örneği gösteriyor).

- [x] **Prod'daki test kayıtlarını temizle** — 2026-08-16 tamamlandı. `Client`
      `testclientnoig0000000000000000` ve ona bağlı post, doğru sırada (`ApprovalAudit`,
      `ApprovalLink`, `PostImage`, `Post`, `Client`) tek transaction içinde silindi.
      "Duman testi" postunun 404 veren `igPermalink`'i `NULL`'landı; `publishStatus` ve
      `igMediaId` bilinçli olarak korundu (post gerçekten yayınlanmıştı).
      **Dikkat — `.env.local` tuzağı:** `DATABASE_URL` **localhost**'a (Docker) bakıyor,
      prod Neon adresi **`POSTGRES_URL`** altında. Prisma varsayılanıyla bağlanan bir betik
      prod'a değil yerel DB'ye düşer. Prod'a yazmadan önce bağlandığın hostu doğrula.

- [ ] **Toplu onay yayın yapmıyor** — `POST /api/approve/[token]/batch` yalnızca onaylıyor;
      Instagram bağlı bir müşteride toplu onaylanan postlar `publishStatus='idle'` kalıp
      **sessizce yayınlanmıyor**. Tekil onay yolundaki `publishApprovedPost()` çağrısı burada yok.
      *Karar gerekiyor:* tek tıkla N post arka arkaya yayınlanmalı mı? Süre riski gerçek —
      slayt container'ı başına ~8.5 sn, 60 sn Vercel tavanı. Muhtemel çözüm: batch yalnızca
      onaylasın, yayınlar kuyruğa alınsın; ya da yayın hedefi olan postlar batch'ten çıkarılsın.
      En azından `idle` kalan postlar panelde görünür olmalı (şu an `PublishBadge` `idle`'da
      hiçbir şey göstermiyor — bu tekil akış için doğru, batch için yanıltıcı).

- [ ] **Instagram bağlama arayüzü yok** — `instagramUserId` / `instagramAccessToken` /
      `instagramTokenExpiry` yalnızca elle SQL ile giriliyor; `/clients` ve `POST /api/clients`
      sadece ad + e-posta alıyor. Bir sonraki müşteride yine prod DB'ye elle yazmak gerekecek.
      *Yapılacak:* `/clients` (ya da müşteri detay sayfası) üzerinde Instagram bağlama alanı.
      Token bir sır — form alanı `type="password"`, `GET` yanıtlarında **asla** dönmemeli
      (bugün `Client` nesnesi hiçbir public endpoint'ten ham dönmüyor, bu korunmalı).
      Kolaylık: token'dan IG_USER_ID'yi bulmak için `GET /me?fields=user_id`.

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
