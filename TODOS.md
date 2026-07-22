# TODOS

Plan review'da (D3/D4 kararları) v1 kapsamı dışına ertelenen işler — v2'de kapatıldı:

- [x] **Çoklu görsel / carousel desteği (D3.3)** — 2026-07-22: `PostImage` tablosu (veri taşıma migration'ıyla), post başına 10 görsele kadar yükleme, onay sayfasında scroll-snap carousel, dashboard'da adet rozeti.
- [x] **Ajans markalama (D3.4)** — 2026-07-22: `/settings` sayfasından logo + marka rengi; onay sayfası ve e-postada uygulanıyor (hex doğrulamalı, injection korumalı).
- [x] **Toplu onay** — 2026-07-22: onay sayfası aynı müşterinin bekleyen diğer postlarını listeler; "Tümünü onayla" tek istekte post başına audit kaydıyla onaylar.
- [x] **Upstash Redis rate limiting (D4)** — 2026-07-22: `checkRateLimit` Upstash REST env değişkenleri varsa dağıtık sayaç kullanır, yoksa/hatada in-memory fallback. Not: Vercel'de Upstash entegrasyonunun kurulup env değişkenlerinin eklenmesi gerekir; eklenene kadar in-memory davranış sürer.
- [x] **Vercel Blob + Resend production kurulumu (T7)** — 2026-07-22 tamamlandı: Blob store `content-approval-images` canlıda, Resend `enesmemduhoglu.tech` doğrulanmış domain'iyle (SPF/DKIM/DMARC) gönderiyor.

## Yeni ertelenenler

- [ ] **Toplu reddetme** — bilinçli kapsam dışı: reddetme sebebi post başına anlamlı olduğu için toplu onayın simetriği yapılmadı.
