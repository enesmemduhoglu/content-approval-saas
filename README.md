# İçerik Onay — content-approval-saas

Küçük sosyal medya ajansları için **tek tıkla müşteri onay akışı**.

Ajanslar, müşterileri için hazırladıkları postların onayını bugün WhatsApp/e-posta karmaşasında yürütüyor: kaybolan mesajlar, sürüm karışıklığı, "onayladı mı?" belirsizliği. Bu uygulama o akışı tek bir linke indirger:

> Ajans postu yükler → müşteriye e-postayla onay linki gider → müşteri **giriş yapmadan**, telefonundan tek tıkla onaylar veya sebep yazarak reddeder → karar, zaman damgası ve IP ile kayıt altına alınır.

**Canlı:** https://content-approval-saas.vercel.app · Spec: [issue #1](https://github.com/enesmemduhoglu/content-approval-saas/issues/1)

## Özellikler

- **Ajans paneli** — Google ile giriş, müşteri yönetimi, post oluşturma (1-10 görsel + caption), durum takibi (taslak / onay bekliyor / onaylandı / reddedildi)
- **Public onay sayfası** — müşteri için üyelik yok, uygulama yok; mobile-first tek sayfa; onay/red + opsiyonel reddetme sebebi; çoklu görselde kaydırmalı carousel; bekleyen diğer postları listeler ve **toplu onay** sunar
- **Ajans markalama** — `/settings`'ten logo + marka rengi; onay sayfası ve e-postalar ajansın kimliğiyle görünür
- **E-posta bildirimi** — post oluşunca müşteriye "İncele ve Onayla" CTA'lı, text+html multipart e-posta (Resend, SPF/DKIM/DMARC doğrulanmış domain)
- **Güvenli linkler** — `crypto.randomUUID` tabanlı token, 7 gün geçerlilik, süresi dolan link çalışmaz
- **Audit** — her onay/red işlemi IP + aksiyon + zaman damgasıyla `ApprovalAudit` tablosuna yazılır

## Stack

| Katman | Teknoloji |
|---|---|
| Framework | Next.js 15 (App Router, React 19) |
| Veritabanı | PostgreSQL + Prisma (production: Neon) |
| Kimlik doğrulama | NextAuth v5 — Google OAuth, JWT session |
| Görsel depolama | Vercel Blob (yerelde dosya sistemi fallback'i) |
| E-posta | Resend |
| Test | Vitest (unit + integration) · Playwright (e2e) |
| Hosting | Vercel |

## Güvenlik tasarımı

- **IDOR koruması:** Route handler'lar Client/Post için asla ham `db.*` çağırmaz. `getScopedDb(session)` her sorguya oturumdaki ajansın `agencyId` filtresini otomatik enjekte eder (`src/lib/scoped-db.ts`) — yeni endpoint eklerken scoping unutulamaz.
- **Atomiklik:** Post + ApprovalLink tek `$transaction` içinde oluşur; linksiz yarım post kalmaz.
- **Yarış koruması:** Onay/red, `WHERE status='pending'` koşullu UPDATE ile yapılır — aynı anda gelen ikinci karar 409 alır, çifte karar imkânsızdır.
- **Rate limit:** Public onay endpoint'i ve sayfası IP başına dakikada 10 istekle sınırlıdır (token brute-force'a karşı). Upstash Redis env değişkenleri varsa sayaç dağıtıktır; yoksa in-memory fallback devrededir. IP bilinemiyorsa audit'e `"unknown"` yazılır, asla boş değer düşmez.
- **Test girişi izolasyonu:** E2E testlerin kullandığı Credentials provider'ı yalnızca `ENABLE_TEST_AUTH=1` iken var olur; production'da yoktur.

## Yerel geliştirme

Gereksinimler: Node 20+, Docker.

```bash
# 1. Postgres (Docker)
docker run -d --name content-approval-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=content_approval -p 5455:5432 postgres:16

# 2. Ortam değişkenleri (.env — hem Next.js hem Prisma CLI okur; .env.local'i Prisma CLI okumaz)
cp .env.example .env         # en az DATABASE_URL, DATABASE_URL_UNPOOLED ve AUTH_SECRET doldur

# 3. Bağımlılıklar + migration
npm install
npx prisma migrate dev

# 4. Çalıştır
npm run dev                  # http://localhost:3000
```

Yerel kolaylıklar (hiçbir dış servis hesabı olmadan tam akış çalışır):

- `ENABLE_TEST_AUTH=1` → Google OAuth kurmadan e-posta + ajans adıyla test girişi
- `BLOB_READ_WRITE_TOKEN` boş → görseller `public/uploads/` altına yazılır
- `RESEND_API_KEY` boş → e-posta gönderimi atlanır, akış kesilmez

### Ortam değişkenleri

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres bağlantısı (pooled) |
| `DATABASE_URL_UNPOOLED` | ✅ | Migration/CLI için doğrudan bağlantı (yerelde `DATABASE_URL` ile aynı; production'da Neon unpooled) |
| `AUTH_SECRET` | ✅ | `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | prod | Google OAuth (boşsa Google girişi kapalı) |
| `BLOB_READ_WRITE_TOKEN` | prod | Vercel Blob |
| `RESEND_API_KEY` / `EMAIL_FROM` | prod | E-posta bildirimi |
| `APP_URL` | prod | Onay linklerinde kullanılan mutlak URL |
| `ENABLE_TEST_AUTH` | — | `1` ise test girişi aktif — **production'da asla** |

## Testler

```bash
# Test veritabanları (bir kez)
docker exec content-approval-pg psql -U postgres \
  -c "CREATE DATABASE content_approval_test;" -c "CREATE DATABASE content_approval_e2e;"

npm test              # vitest: unit + integration (gerçek Postgres'e karşı)
npm run test:e2e      # Playwright: 3111 portunda kendi dev sunucusunu açar
```

Kapsam: token üretimi/expiry, rate limit eşiği, validasyon, e-posta hata toleransı, cross-agency erişim reddi (403), transaction rollback, çifte karar yarışı, süresi dolmuş/geçersiz token, boş durumlar ve tam e2e akışı (giriş → müşteri → post → incognito onay → dashboard doğrulama, double-submit dahil).

## Deploy (Vercel)

Proje Vercel'e bağlıdır; `vercel deploy --prod` yeterlidir. `vercel-build` script'i her deploy'da önce `prisma migrate deploy` çalıştırır — migration'lar otomatik uygulanır. Postgres, Vercel Marketplace üzerinden Neon'dur (`DATABASE_URL` pooled, `DATABASE_URL_UNPOOLED` migration için).

## Mimari

```
[Ajans tarayıcısı] ──Google OAuth──▶ [NextAuth v5, JWT]
[Ajans tarayıcısı] ──▶ /dashboard, /clients          (session + getScopedDb)
                       /api/clients, /api/posts       (session + getScopedDb + $transaction)
                                     └─▶ Vercel Blob (görsel) · Resend (e-posta)
[Müşteri, girişsiz] ──▶ /approve/[token]              (public, rate limit, token+expiry)
                        /api/approve/[token]          (WHERE status='pending' + audit)
                                     └─▶ Postgres (Neon)
```

## Yol haritası

Bkz. [TODOS.md](TODOS.md) — çoklu görsel/carousel, ajans markalama, toplu onay, dağıtık rate limiting (Upstash).
