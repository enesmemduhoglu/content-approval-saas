# TODOS

Plan review'da (D3/D4 kararları) bilinçli olarak v1 kapsamı dışına ertelenen işler:

- [ ] **Çoklu görsel / carousel desteği (D3.3)** — Post başına tek görsel varsayımı `Post.imageUrl` alanında; çoklu görsel için ayrı `PostImage` tablosuna geçiş gerekir.
- [ ] **Ajans markalama (D3.4)** — Onay sayfası ve e-postada ajans logosu/renkleri. Şimdilik yalnızca ajans adı gösteriliyor.
- [ ] **Toplu onay** — Müşterinin birden çok postu tek sayfada onaylaması.
- [ ] **Upstash Redis rate limiting (D4)** — `src/lib/rate-limit.ts` in-memory sabit pencere kullanıyor; serverless'ta instance'lar arasında paylaşılmaz. Production trafiği büyürse Upstash Redis'e taşı.
- [x] **Vercel Blob + Resend production kurulumu (T7)** — 2026-07-22 tamamlandı: Blob store `content-approval-images` canlıda, Resend `enesmemduhoglu.tech` doğrulanmış domain'iyle (SPF/DKIM/DMARC) gönderiyor.
