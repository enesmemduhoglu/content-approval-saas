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

- [ ] **Prod'daki test kayıtlarını temizle** — 2026-08-16 doğrulamasından kalanlar:
      - `Client` id `testclientnoig0000000000000000` ("Regresyon Testi (Instagramsiz)")
      - Ona bağlı "Regresyon testi" postu (`publishStatus='skipped'`)
      - "Duman testi" postu — Instagram'daki karşılığı elle silindi, ama `igPermalink`
        DB'de duruyor; panelde "Instagram'da gör" linki artık 404 veriyor.
      *Not:* silme sırası önemli — `ApprovalAudit`, `ApprovalLink`, `PostImage`, sonra `Post`, `Client`.

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

### Bu listede olmayan, ayrı repo

`furi` tarafındaki Faz 2 değişikliği (SKILL.md'nin SaaS'a POST atması, Gmail/apps-script
zincirinin emekliye ayrılması) yapılmadı. Uçtan uca otomasyon ancak o repo güncellenince tamamlanır.
