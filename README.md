# content-approval-saas

Sosyal medya içerik onay akışı — küçük ajanslar için. Ajans, müşterisi için hazırladığı postu yükler; müşteri giriş yapmadan, e-postasına gelen tek kullanımlık linkten onaylar veya reddeder. Spec: [issue #1](https://github.com/enesmemduhoglu/content-approval-saas/issues/1).

## Stack

Next.js (App Router) · Postgres + Prisma · NextAuth (Google) · Vercel Blob · Resend

## Yerel geliştirme

```bash
# 1. Postgres (Docker)
docker run -d --name content-approval-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=content_approval -p 5455:5432 postgres:16

# 2. Ortam değişkenleri
cp .env.example .env.local   # DATABASE_URL ve AUTH_SECRET doldur

# 3. Bağımlılıklar + migration
npm install
npx prisma migrate dev

# 4. Çalıştır
npm run dev
```

`ENABLE_TEST_AUTH=1` ile Google OAuth kurmadan test girişi (e-posta + ajans adı) kullanabilirsin — yalnızca yerel geliştirme için. `BLOB_READ_WRITE_TOKEN` boşsa görseller `public/uploads/` altına yazılır; `RESEND_API_KEY` boşsa e-posta gönderimi atlanır (akış çalışmaya devam eder).

## Testler

```bash
npm test              # unit + integration (vitest; test DB: content_approval_test)
npm run test:e2e      # Playwright e2e (kendi dev sunucusunu 3111 portunda açar)
```

Test ve e2e veritabanları:

```bash
docker exec content-approval-pg psql -U postgres \
  -c "CREATE DATABASE content_approval_test;" -c "CREATE DATABASE content_approval_e2e;"
```

## Mimari notlar

- **Agency scoping (IDOR koruması):** Route handler'lar Client/Post için ham `db.*` çağırmaz; `getScopedDb(session)` her sorguya `agencyId` filtresi enjekte eder (`src/lib/scoped-db.ts`).
- **Atomiklik:** Post + ApprovalLink `$transaction` içinde oluşur — linksiz yarım post kalmaz.
- **Yarış koruması:** Onay/red, `WHERE status='pending'` koşullu UPDATE ile yapılır; aynı anda gelen ikinci karar 409 alır.
- **Rate limit:** Public onay endpoint'i ve sayfası IP başına dakikada 10 istekle sınırlı (in-memory, bkz. TODOS.md).
- **Audit:** Her onay/red işlemi `ApprovalAudit`'e IP + aksiyon + zaman damgasıyla yazılır; IP bilinmiyorsa `"unknown"`.
