# İçerik Onay — content-approval-saas

Küçük sosyal medya ajansları ve içerik üreticileri için **onay + Instagram yayın hattı**.
İki ayrı yüzeyi var:

1. **Ajans paneli + girişsiz onay linki.** Ajans postu (görsel, karusel ya da Reels)
   hazırlar, müşteriye e-postayla onay linki gider; müşteri üye olmadan telefonundan
   onaylar, reddeder ya da revizyon ister. Karar zaman damgası ve IP ile kayda geçer,
   onaylanan post Instagram'a yayınlanır.
2. **Müşteri portalı / video kuyruğu (PWA).** Sayfa sahibi telefonuna kurduğu
   uygulamadan video yükler; caption otomatik üretilir; kuyruğu sıralar, onaylar ve
   videolar seçtiği gün ve saatlerde Instagram Reels olarak kendiliğinden yayınlanır.

**Canlı:** https://content-approval-saas.vercel.app

## Özellikler

### Ajans paneli ve onay linki

- **Google ile giriş**, müşteri yönetimi, post oluşturma (1–10 görsel + caption), durum takibi
- **Girişsiz onay sayfası** (`/approve/[token]`) — mobile-first; onay / red (+ sebep);
  karusel; Reels oynatıcı; bekleyen diğer postlar için **toplu onay**
- **Revizyon turu** — müşteri düzeltme ister, ajans yeniden gönderir; her tur
  `PostRevision` zincirinde sürümüyle durur
- **Güvenli linkler** — tahmin edilemez token, 7 gün geçerlilik
- **Audit** — her karar IP + aksiyon + zamanla `ApprovalAudit`'e yazılır, panelde okunur
- **Ekip** — ajans başına birden çok üye, e-posta daveti, `owner` / `member` rolleri
- **Markalama** — `/settings`'ten logo + marka rengi; onay sayfası ve e-postalar ajansın kimliğiyle
- **Instagram yayını** — Instagram bağlı müşteride onay = yayın; karusel; Reels iki fazlı
  (container → yayın); mükerrer yayın koruması; token'ların otomatik yenilenmesi
- **Zamanlanmış yayın** — `Post.publishAt` doluysa yayın günlük cron'a bırakılır (±24 saat, bkz. Cron'lar)
- **Bildirimler** — müşteriye onay maili, ajans ekibine karar/yayın bildirimi, bekleyen
  posta tek seferlik hatırlatma, sistem uyarıları `ALERT_EMAIL`'e
- **Portal erişimi** — `/clients`'ta müşteri başına portal kullanıcısı ekleme/kaldırma
- **Makine yolu (furi)** — ayrı bir otomasyon API anahtarıyla post oluşturur, Reels'i
  imzalı URL ile Blob'a yükler ve Instagram token'ını tek kaynaktan çeker

### Müşteri portalı / video kuyruğu (`/portal`)

- **PWA** — ana ekrana kurulur; **müşteriye özel** ad, ikon ve tema rengi (dinamik
  manifest, `Client.app*` alanları); iOS meta'sı, güvenli alan payları, çevrimdışı sayfası,
  "yeni sürüm hazır" bandı, iOS'ta kurulum rehberi
- **Giriş** — e-postaya **magic link + 6 haneli kod** (iOS'ta kurulu PWA'nın çerezleri
  Safari'den ayrı olduğu için kod şart); 30 günlük **kaydırmalı** oturum
- **Yükleme** — galeriden seçince başlar; 16 MB üstü dosyalar **8 MB'lık parçalarla**
  doğrudan R2'ye (3 paralel parça), uygulamadan çıkıp dönünce ya da aynı dosya yeniden
  seçilince **kaldığı yerden devam** (IndexedDB); ekran kilidi (wakeLock); aynı videonun
  ikinci kez yüklenmesine uyarı; en fazla 300 MB; müşteri başına günlük yükleme tavanı
- **Otomatik caption** — tarayıcı videodan 6 kare çıkarır; sunucuda fal Whisper
  transkript + Claude (kareler + transkript + müşterinin caption stili) açıklama ve
  10–15 hashtag üretir; kod tarafında doğrulanır; not ile ("daha kısa olsun") yeniden üretme
- **Kuyruk** — sürükle-bırak sıralama (mobilde oklar), tahmini yayın zamanları,
  "Sıradaki yayın" kartı, **kuyruk kaç gün yeter** göstergesi
- **Karar** — onayla (→ sıradakine geç) / reddet / reddi **geri al** / kuyruktan çıkar /
  sona at / hatalı yayını tekrar dene / kuyruk dışı videoyu **kalıcı sil**
- **Yayın ayarları** (`PublishSettings`) — yayın **günleri** × saatleri (slot), saat
  dilimi, onay zorunlu mu (kapalıysa sırası gelen video otomatik onaylanır ve
  `auto_approved` olarak audit'e yazılır), duraklatma, bildirim e-postası
- **Slot tabanlı yayın** — QStash her 5 dakikada `/api/queue/tick`'i çağırır; vadesi
  gelen slotta kuyruktaki sıradaki uygun video Reels olarak yayınlanır; 1 saatten
  fazla kaçmış slot telafi edilmez
- **Bildirimler** — e-posta **ve Web Push**: yayınlandı, yayın hatası, "onaylı video
  yok", caption'lar hazır, **günlük özet** (onay bekleyenler, yarın ne yayınlanacak,
  kuyruk bugün/yarın bitiyor)
- **Geçmiş** — yayınlananlar (Instagram linkiyle) ve başarısızlar; okunur hata metinleri;
  Instagram bağlantısı kopmuşsa uyarı

## Stack

| Katman | Teknoloji |
|---|---|
| Framework | Next.js 15 (App Router, React 19) |
| Veritabanı | PostgreSQL + Prisma 6 (production: Neon) |
| Ajans kimliği | NextAuth v5 — Google OAuth, JWT oturum |
| Müşteri portalı kimliği | Kendi HMAC-imzalı çerezi + magic link / 6 haneli kod (NextAuth dışında) |
| Görsel depolama (ajans, furi Reels) | Vercel Blob (yerelde `public/uploads/` fallback'i) |
| Video depolama (portal) | Cloudflare R2 — gizli bucket, süreli imzalı URL, S3 multipart |
| Arka plan işleri | Upstash QStash (5 dk tick + video başına caption işi) · Vercel Cron (günlük) |
| Transkript | fal.ai `fal-ai/whisper` |
| Caption üretimi | Anthropic Claude (`claude-sonnet-5`) |
| E-posta | Resend |
| Telefon bildirimi | Web Push (`web-push`, VAPID) + service worker |
| Rate limit | Upstash Redis (yoksa in-memory) |
| Sürükle-bırak | `@dnd-kit` |
| Test | Vitest (entegrasyon + React) · Playwright (e2e) |
| Hosting | Vercel |

## Mimari

```
[Ajans tarayıcısı] ──Google OAuth──▶ NextAuth v5 (JWT) ── googleId → AgencyMember → session.agencyId
      │
      └─▶ /dashboard /clients /settings · /api/clients /api/posts /api/agency/*   (getScopedDb)
                         └─▶ Vercel Blob (görsel) · Resend (e-posta)

[Müşteri, girişsiz] ──▶ /approve/[token] · /api/approve/[token]   (rate limit, WHERE status='pending')
                         └─▶ ajans postunda onay = publishApprovedPost() ──▶ Instagram Graph API

[Müşteri, PWA] ──çerez cas_portal──▶ /portal/** · /api/portal/**   (getClientScopedDb, checkOrigin)
      │  yükle: upload → parts (imzalı PUT) ──doğrudan──▶ Cloudflare R2 ◀── complete (HeadObject)
      │                                                                        │
      │                                                         QStash ◀── enqueueCaption
      │                                                           │
      │                               POST /api/queue/caption/[postId]   (QStash imzası)
      │                                 fal Whisper (R2 imzalı URL) + Claude (kareler + transkript)
      │                                 └─▶ captionStatus = ready · Web Push "caption'lar hazır"
      │
      └─ ayarlar: PublishSettings (günler × saatler, onay modu, duraklat)

[QStash schedule */5] ──▶ /api/queue/tick   (QStash imzası; yedek: Bearer CRON_SECRET)
      dueSlots → SlotRun INSERT (UNIQUE = tek kazanan) → pickNext → (onay kapalıysa auto_approved)
      └─▶ publishApprovedPost() → Reels (R2 imzalı URL) · takılı Reels'i resumePublish
      └─▶ sonuç e-postası + Web Push (müşteri) · hata: ajans ekibi + ALERT_EMAIL

[Vercel Cron, günlük] ──Bearer CRON_SECRET──▶ /api/cron/refresh-instagram-tokens
                                              /api/cron/publish-scheduled   (+ takılı video yayınları)
                                              /api/cron/pending-reminders   (+ kuyruk günlük özeti,
                                                                              24 saatlik taslak temizliği)

[furi (makine)] ──Bearer FURI_API_KEY──▶ POST /api/posts · GET /api/posts/[id]
                                        POST /api/media/upload-url   (Reels için Blob imzalı URL)
                                        GET  /api/clients/[id]/instagram-token
```

**Anlaşılması zor üç ayrım:**

- **Onay ≠ yayın.** `Post.status` müşterinin kararı, `Post.publishStatus` Instagram tarafı.
  Yayın, onay commit olduktan **sonra** ayrı adımda denenir; yayın patlarsa onay yerinde kalır.
- **Dört yayın tetikleyicisi** (onay yolu, `publish-scheduled` cron'u, onay sayfasındaki
  "tekrar dene", kuyruk tick'i) aynı `publishApprovedPost`'tan ve aynı koşullu UPDATE
  kilidinden geçer — tek kazanan garanti, onaysız post hiçbir yoldan yayınlanmaz.
  Portal postu (`source = portal`) onaylanınca **anında yayınlanmaz**; slotunu bekler.
- **İki ayrı kimlik.** Ajans NextAuth oturumuyla, müşteri portalı kendi çereziyle girer;
  ikisi hiçbir noktada birbirinin yerine geçmez. Portal yalnızca müşterinin **kendi
  yüklediği** videoları görür; ajansın hazırladığı postlar onay linki akışında kalır.

## Güvenlik tasarımı

- **IDOR:** Ajans route'ları Client/Post için ham `db.*` çağırmaz; `getScopedDb(session)`
  her sorguya `agencyId` filtresini enjekte eder (`src/lib/scoped-db.ts`). Portalın eşi
  `getClientScopedDb` (`src/lib/client-scoped-db.ts`): her sorgu oturumdan gelen
  `clientId` **ve** `source: "portal"` filtresini taşır. R2 imzalı URL'i ancak anahtarın o
  müşteriye ait olduğu doğrulandıktan sonra üretilir (`keyBelongsToClient`).
- **Yarış koruması:** Karar değiştiren her yol koşullu UPDATE'tir
  (`updateMany({ where: { beklenen durum } })`, `count === 0` → 409). Kuyrukta aynı slotun
  iki kez yayın yapmasını `SlotRun (clientId, slotAt)` UNIQUE kısıtı engeller.
- **CSRF ikinci katmanı:** Çerezli mutasyon route'ları `Origin`'i doğrular
  (`src/lib/origin.ts`); API anahtarıyla gelen makine yolu muaftır.
- **Sırlar şifreli:** `Client.instagramAccessToken` AES-256-GCM ile `enc:v1:` önekli yazılır
  (`src/lib/crypto.ts`). Portal giriş token'ı ve kodu yalnızca hash olarak saklanır. Loglar
  ve hata metinleri sır taşımaz.
- **Rate limit:** Onay sayfası/uç noktası IP başına dakikada 10; portal girişi IP ve
  e-posta başına; portal mutasyonları **müşteri** başına (IP değil). Kodla girişte token
  başına 5, kullanıcı başına 24 saatte 20 hatalı deneme tavanı. Upstash varsa sayaç dağıtık.
- **Portal oturumu:** `AUTH_SECRET`'ten etiketle türetilmiş ayrı anahtarla HMAC-imzalı
  çerez (`cas_portal`) **+ her istekte `ClientUser` satırının DB'den doğrulanması** —
  ajans erişimi kaldırınca çerez bir sonraki istekte ölür. Magic link GET'te harcanmaz
  (e-posta tarayıcılarının ön açması token'ı yakmasın); giriş yanıtı adresin kayıtlı
  olup olmadığını sızdırmaz.
- **Arka plan uç noktaları:** `/api/queue/*` QStash imzasıyla (`Receiver`) doğrulanır;
  imza anahtarları yoksa kapalıdır. Cron'lar `CRON_SECRET` ister; sır yoksa 401.
- **Service worker:** kapsamı `/portal`; `/api/**`, oturumlu HTML ve R2 imzalı URL'leri
  **asla** önbelleğe almaz. Bildirim tıklaması yalnızca `/portal…` ya da https Instagram
  linkine gider (open redirect yok).
- **Dosya doğrulaması içerikten:** yüklenen görselin tipi ilk baytlardan tespit edilir;
  portal videosu `complete`'te `HeadObject` ile boyut ve tip olarak sunucuda doğrulanır.
- **Kötüye kullanım supapları:** ajans başına müşteri/post/günlük post/davet kotası
  (`src/lib/quota.ts`); müşteri başına 24 saatte portal yükleme tavanı.
- **Test girişi izolasyonu:** Credentials provider yalnızca `ENABLE_TEST_AUTH=1` **ve**
  `NODE_ENV !== "production"` iken vardır.

## Yerel geliştirme

Gereksinimler: Node 22 (CI'daki sürüm), Docker.

```bash
# 1. Postgres (Docker) — testlerle aynı konteyner
docker run -d --name cas-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=content_approval_test -p 5455:5432 postgres:16-alpine
# geliştirme ve e2e veritabanları (konteyner bunları oluşturmaz)
docker exec cas-test-pg psql -U postgres -c "CREATE DATABASE content_approval;" \
  -c "CREATE DATABASE content_approval_e2e;"

# 2. Ortam değişkenleri (.env — Prisma CLI .env.local'i okumaz)
cp .env.example .env         # en az DATABASE_URL, DATABASE_URL_UNPOOLED, AUTH_SECRET

# 3. Bağımlılıklar + migration
npm install                  # postinstall: prisma generate
npx prisma migrate dev

# 4. Çalıştır
npm run dev                  # http://localhost:3000
```

Hiçbir dış servis hesabı olmadan çekirdek onay akışı çalışır:

- `ENABLE_TEST_AUTH=1` → Google OAuth kurmadan test girişi
- `BLOB_READ_WRITE_TOKEN` boş → görseller `public/uploads/` altına
- `RESEND_API_KEY` boş → e-posta atlanır, akış kesilmez
- `ENCRYPTION_KEY` boş → token düz metin yazılır ve yüksek sesle uyarılır (production'da bu yol kapalı)

Portal yüklemesi **R2 ister** (yoksa 503). QStash yerel makineye ulaşamadığı için yerelde
caption işi kendiliğinden koşmaz; elle tetiklemek için:
`curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/queue/caption/<postId>`
(tick için aynısı `/api/queue/tick`). Caption hattını DB'siz denemek için
`scripts/caption-dene.ts` var (kullanımı dosyanın başında).

### Ortam değişkenleri

> `.env.example` yalnızca ajans tarafını içeriyor; video kuyruğu değişkenleri (R2, QStash,
> fal, Anthropic, VAPID, `PORTAL_DAILY_UPLOAD_LIMIT`) orada henüz yok — bu tablo esastır.

**Çekirdek**

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres (production'da Neon pooled) |
| `DATABASE_URL_UNPOOLED` | ✅ | Migration/CLI için doğrudan bağlantı (yerelde `DATABASE_URL` ile aynı) |
| `AUTH_SECRET` | ✅ | NextAuth + portal çerez/kod imzalarının kök sırrı. `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | prod | DB'deki Instagram token'larını şifreler (base64, 32 bayt). **Kaybedilirse tüm hesaplar yeniden bağlanmalı.** |
| `APP_URL` | prod | Mutlak adres: onay/giriş linkleri, e-postalar, QStash'in çağıracağı caption adresi |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | prod | Google OAuth (boşsa Google girişi kapalı) |
| `BLOB_READ_WRITE_TOKEN` | prod | Vercel Blob (ajans görselleri, furi Reels) |
| `RESEND_API_KEY` / `EMAIL_FROM` | prod | E-posta |
| `CRON_SECRET` | prod | Vercel cron'larının Bearer sırrı; `/api/queue/*` için yedek kimlik. Boşsa cron'lar 401 |
| `ALERT_EMAIL` | prod | Sistem uyarıları (cron çökmesi, yayın hatası, caption/kare sorunları). Boşsa yalnızca log |

**Video kuyruğu / portal**

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | portal | Cloudflare R2. Anahtar yalnızca o bucket'a yetkili olmalı. Boşsa portal yüklemesi açık hatayla kapalı |
| `QSTASH_TOKEN` | portal | Caption işini kuyruğa atmak için. Boşsa caption `pending` kalır |
| `QSTASH_URL` | portal | QStash bölge adresi — token bölgeye özel; verilmezse SDK başka bölgeye düşebilir |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | portal | Gelen QStash isteklerinin imza doğrulaması. Boşsa imzalı istekler reddedilir |
| `FAL_KEY` | portal | fal Whisper transkripti. Boşsa caption `failed` |
| `ANTHROPIC_API_KEY` | portal | Claude ile caption üretimi. Boşsa caption `failed` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | — | Web Push (`VAPID_SUBJECT` örn. `mailto:...`). Biri bile eksikse push atlanır (loglanır), portaldaki bildirim anahtarı "kullanılamıyor" durumuna geçer |
| `PORTAL_DAILY_UPLOAD_LIMIT` | — | Müşteri başına 24 saatte yükleme tavanı (varsayılan 40) |

**Opsiyonel**

| Değişken | Açıklama |
|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Dağıtık rate limit ve bildirim kısması. Vercel Marketplace adları `KV_REST_API_URL` / `KV_REST_API_TOKEN` da tanınır |
| `QUOTA_MAX_CLIENTS` / `QUOTA_MAX_POSTS` / `QUOTA_MAX_POSTS_PER_DAY` / `QUOTA_MAX_PENDING_INVITES` | Kota tavanları; tanımsız ya da bozuksa varsayılan |
| `FURI_API_KEY` / `FURI_API_AGENCY_ID` | Makine erişimi. Anahtar ≥ 32 karakter; ikisi de boşsa makine yolu kapalı |
| `IG_API_HOST` / `IG_API_VERSION` | Instagram Graph API hedefini değiştirmek için (testler) |
| `ENABLE_TEST_AUTH` | `1` → test girişi. **Production'da asla** (kod ayrıca engeller) |

**Yalnızca test/betik:** `TEST_DATABASE_URL`, `E2E_DATABASE_URL` (varsayılanları
`localhost:5455`), `POSTGRES_URL` / `DB_URL_ENV` (`scripts/*.mjs` bakım betiklerinin
bağlanacağı adres), `CAPTION_DENE_ENV` (`caption-dene.ts` anahtar dosyası).

## Testler

```bash
npm test                          # vitest: entegrasyon + React — GERÇEK Postgres'e karşı
npm test -- src/lib/queue.test.ts # tek dosya
npm test -- src/app/api/portal    # yol önekiyle bir grup
npm run test:e2e                  # Playwright: ayrı DB, 3111 portunda kendi dev sunucusu
npx tsc --noEmit                  # tip kontrolü (depoda linter yok; statik kapı bu)
npm run build                     # prod build
```

- **Testler Postgres'i kendisi başlatmaz.** `cas-test-pg` çalışmıyorsa (`docker start cas-test-pg`)
  global setup bağlanamayıp patlar. Entegrasyon testleri tek DB paylaştığı için dosyalar
  sırayla koşar (`fileParallelism: false`); şifreleme testlerde açıktır.
- Üç tür: `src/**/*.test.ts` (route handler'lar doğrudan çağrılır), `src/**/*.ui.test.tsx`
  (jsdom), `tests/e2e/*.spec.ts` (Playwright). Ayrıntı `CLAUDE.md`'de.
- Dış servisler (R2, QStash, fal, Claude, Instagram, Web Push) testlerde mock'ludur;
  her portal route'u için IDOR testi vardır.
- **CI** (`.github/workflows/ci.yml`) her PR'da `tsc` + testleri koşar ve migration'ları
  boş bir DB'ye uygulayıp `schema.prisma` ile kaymadığını doğrular. e2e CI dışında.

## Deploy

GitHub'a bağlı: **`master`'a merge → production**, PR → preview. Postgres, Vercel
Marketplace üzerinden Neon.

> **⚠ Merge = prod şema göçü.** `vercel-build` = `prisma migrate deploy && next build`;
> master'a giren migration elle hiçbir şey yapılmadan prod'a uygulanır. Şema değiştiren
> PR'ı boş DB'de **ve prod'a benzeyen veriyle** sınamadan merge etme.

> Env değişikliği çalışan deployment'ı etkilemez — `vercel redeploy` gerekir. Vercel'de
> Sensitive işaretli değerler geri okunamaz; sır olmayanları `--no-sensitive` ekle.

### Zamanlanmış işler

**Vercel Cron** (`vercel.json`, günlük, hepsi `Authorization: Bearer $CRON_SECRET`):

| Saat (UTC) | Yol | Ne yapar |
|---|---|---|
| 03:00 | `/api/cron/refresh-instagram-tokens` | Bitişine ≤ 20 gün kalan Instagram token'larını uzatır |
| 05:00 | `/api/cron/publish-scheduled` | `publishAt`'i gelmiş onaylı postları yayınlar; takılı video yayınlarını ilerletir |
| 09:00 | `/api/cron/pending-reminders` | 2 gündür bekleyen posta hatırlatma, linki ölen posta ajans bildirimi; **kuyruk günlük özeti**; 24 saatlik yarım yükleme (taslak) temizliği |

Hobby planında cron günde bire sınırlı ve ±59 dk oynar; bu yüzden ajansın `publishAt`
çözünürlüğü ±24 saattir. `instagramTokenExpiry` boş bırakılan müşterinin token'ı
otomatik yenilenmez.

**Upstash QStash** (dakika hassasiyeti gereken işler):

- **Schedule** — `*/5 * * * *` → `POST {APP_URL}/api/queue/tick`. Repo bunu kurmaz;
  QStash panelinden (ya da API'sinden) bir kez oluşturulur. Yedek tetikleyici olarak
  herhangi bir cron servisi aynı adrese `Authorization: Bearer $CRON_SECRET` ile GET/POST atabilir.
- **Caption işleri** — her tamamlanan yükleme ve "yeniden üret" için kod tarafından
  `POST /api/queue/caption/[postId]` mesajı yayınlanır (3 yeniden deneme).

**Elle kurulanlar:** R2 bucket CORS'u (portal adresi + `localhost:3000` için `PUT`/`GET`,
`ExposeHeaders: ETag`) ve tamamlanmamış çok parçalı yüklemeleri iptal eden lifecycle kuralı;
bir müşterinin caption stili (`scripts/caption-stili-yukle.mjs`) ve uygulama adı/ikonu
(`Client.app*`, ikonlar `scripts/pwa-ikon-uret.mjs` ile `public/icons/<klasör>/`) —
bunların panel arayüzü yok.

## Operasyon notları

- **Hata izleme e-postayla** — dış servis yok; `ALERT_EMAIL` tanımlı değilse uyarılar yalnızca loga düşer.
- **Dayanıklılık** — çekirdek onay akışı yalnızca Vercel + Neon ile ayakta kalır; Resend,
  Upstash, Web Push düşerse akış sürer. Bildirimler (`sendAlert`, push) hiçbir koşulda
  yayını ya da tick'i düşürmez.
- **Girişi canlı alias'tan yap.** `trustHost: true` ile OAuth callback isteğin geldiği
  host'tan türetilir; deployment'a özel URL'den girişte `redirect_uri_mismatch` alınır.
- **`GET /api/health`** — uptime izlemesi için; DB'yi `SELECT 1` ile sınar, bilgi sızdırmaz.
- **Gmail spam** — kuyruk e-postaları spam'e düşebilir; Web Push bu yüzden eklendi.

## Belgeler

- **[`CLAUDE.md`](CLAUDE.md)** — komutlar, test düzeni, **değişmezler** (IDOR, koşullu
  UPDATE, e-posta/bildirim yolları, `checkOrigin`) ve tuzaklar. Kod yazmadan önce oku.
- **[`TODOS.md`](TODOS.md)** — açık işler ve karar günlüğü (bilinçli kapsam dışı
  maddeler, bilinen sınırlar). "Neden böyle yapılmamış" sorusunun cevabı çoğunlukla orada.
- **[`docs/video-kuyrugu/`](docs/video-kuyrugu/)** — portal ve video kuyruğunun belgeleri:
  - [`FAZLAR.md`](docs/video-kuyrugu/FAZLAR.md) — faz durumu ve **oturum devri**; yeni oturum buradan başlar
  - [`README.md`](docs/video-kuyrugu/README.md) — tasarım
  - [`KARARLAR.md`](docs/video-kuyrugu/KARARLAR.md) — karar günlüğü (K1…)
  - [`caption-stili.md`](docs/video-kuyrugu/caption-stili.md) — caption kuralları
  - [`V7-pwa.md`](docs/video-kuyrugu/V7-pwa.md), [`V8-yayin-gunleri.md`](docs/video-kuyrugu/V8-yayin-gunleri.md) — faz şartnameleri
