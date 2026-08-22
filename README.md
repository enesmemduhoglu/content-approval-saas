# İçerik Onay — content-approval-saas

Küçük sosyal medya ajansları için **tek tıkla müşteri onay akışı**.

Ajanslar, müşterileri için hazırladıkları postların onayını bugün WhatsApp/e-posta karmaşasında yürütüyor: kaybolan mesajlar, sürüm karışıklığı, "onayladı mı?" belirsizliği. Bu uygulama o akışı tek bir linke indirger:

> Ajans postu yükler → müşteriye e-postayla onay linki gider → müşteri **giriş yapmadan**, telefonundan tek tıkla onaylar veya sebep yazarak reddeder → karar, zaman damgası ve IP ile kayıt altına alınır.

**Canlı:** https://content-approval-saas.vercel.app · Spec: [issue #1](https://github.com/enesmemduhoglu/content-approval-saas/issues/1)

## Özellikler

**Onay akışı**
- **Public onay sayfası** — müşteri için üyelik yok, uygulama yok; mobile-first tek sayfa; onay/red + opsiyonel reddetme sebebi; çoklu görselde kaydırmalı carousel; bekleyen diğer postları listeler ve **toplu onay** sunar
- **Revizyon turu** — müşteri "şunu düzelt" diyebilir; ajans düzeltip yeniden gönderir; her tur `PostRevision` zincirinde sürümüyle birlikte durur, geçmiş kopmaz
- **Güvenli linkler** — `crypto.randomUUID` tabanlı token, 7 gün geçerlilik, süresi dolan link çalışmaz
- **Audit** — her onay/red işlemi IP + aksiyon + zaman damgasıyla `ApprovalAudit` tablosuna yazılır; panelde karar geçmişi olarak okunur

**Ajans paneli**
- Google ile giriş, müşteri yönetimi, post oluşturma (1-10 görsel + caption), durum takibi
- **Ekip üyeleri** — ajans başına birden çok kişi; e-posta daveti, `owner`/`member` rolleri
- **Post yönetimi** — post/müşteri silme, onay linkini yenileme, onay mailini tekrar gönderme
- **Ajans markalama** — `/settings`'ten logo + marka rengi; onay sayfası ve e-postalar ajansın kimliğiyle görünür

**Instagram yayını**
- Onay = yayın (opt-in): Instagram bağlı müşteride onay aynı istekte yayını tetikler
- **Zamanlanmış yayın** — `Post.publishAt` doluysa yayın cron'a bırakılır (çözünürlük sınırı için "Cron'lar" bölümüne bak)
- Karusel desteği, mükerrer yayın koruması, token'ların otomatik yenilenmesi

**Bildirim ve operasyon**
- Müşteriye onay maili, ajansa karar/yayın bildirimi, bekleyen posta hatırlatma (post başına tek seferlik)
- **Sistem uyarıları** — cron çökmesi, yayın hatası ve Resend reddi `ALERT_EMAIL`'e düşer
- **`GET /api/health`** — uptime izlemesi için; DB canlılığını sınar, sır sızdırmaz

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

- **Sırlar şifreli duruyor:** `Client.instagramAccessToken` veritabanına AES-256-GCM ile şifrelenmiş yazılır (`src/lib/crypto.ts`, `enc:v1:` önekli). Bu token bir uygulama sırrı değil, müşterinin Instagram hesabına yayın yetkisidir — bir DB dump'ı ya da yedek onu düz metin vermemeli. Önek taşımayan eski kayıtlar düz metin kabul edilip okunur (kesintisiz geçiş) ve ilk yazmada şifreliye döner; bekleyen kalıntıyı `scripts/token-sifrele.mjs` çevirir.
- **IDOR koruması:** Route handler'lar Client/Post için asla ham `db.*` çağırmaz. `getScopedDb(session)` her sorguya oturumdaki ajansın `agencyId` filtresini otomatik enjekte eder (`src/lib/scoped-db.ts`) — yeni endpoint eklerken scoping unutulamaz.
- **Atomiklik:** Post + ApprovalLink tek `$transaction` içinde oluşur; linksiz yarım post kalmaz.
- **Yarış koruması:** Onay/red, `WHERE status='pending'` koşullu UPDATE ile yapılır — aynı anda gelen ikinci karar 409 alır, çifte karar imkânsızdır.
- **Rate limit:** Public onay endpoint'i ve sayfası IP başına dakikada 10 istekle sınırlıdır (token brute-force'a karşı). Upstash Redis env değişkenleri varsa sayaç dağıtıktır; yoksa in-memory fallback devrededir. IP bilinemiyorsa audit'e `"unknown"` yazılır, asla boş değer düşmez.
- **Test girişi izolasyonu:** E2E testlerin kullandığı Credentials provider'ı yalnızca `ENABLE_TEST_AUTH=1` iken var olur; `NODE_ENV === "production"` mutlak bir kapıdır — env yanlış ayarlansa bile provider eklenmez.
- **CSRF ikinci katmanı:** Oturum çerezi `SameSite=Lax` ama `multipart/form-data` kabul eden yollar CORS'un "basit istek" sınıfına girdiği için tek katmana bırakılmadı; mutasyon route'ları `Origin` başlığını da doğrular (`src/lib/origin.ts`). İzin verilen origin isteğin kendi host'undan türetilir — preview dağıtımları env listesi gerektirmeden çalışır. API anahtarıyla gelen makine yolu muaftır.
- **Görsel doğrulaması içerikten:** Yüklenen dosyanın gerçek tipi ilk baytlardan (magic number) tespit edilir; istemcinin `Content-Type` beyanına güvenilmez ve uzantı gerçek tipten türetilir.
- **Sır dağıtan uç nokta izleniyor:** `/api/clients/[id]/instagram-token` rate limit'e tabidir ve her erişim `clientId` + zaman + sonuç olarak loglanır (token'ın kendisi asla loglanmaz).
- **Kota tavanları:** Ajans başına müşteri/post tavanı ve **kayan 24 saatte** post tavanı (`src/lib/quota.ts`). Bir plan/faturalama sistemi değil; tek bir kaçak script'in Blob ve Resend kotasını tüketmesini engelleyen kaba bir supap.
- **İstemci IP'si:** `x-vercel-forwarded-for` önceliklidir (platform yazar, istemci üzerine yazamaz); `ApprovalAudit.ip` bir onayın kanıtı olarak saklandığı için bu sıralama önemlidir.

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
- `ENCRYPTION_KEY` boş → token'lar düz metin yazılır (yüksek sesle uyarılır); production'da bu yol kapalıdır

### Ortam değişkenleri

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres bağlantısı (pooled) |
| `DATABASE_URL_UNPOOLED` | ✅ | Migration/CLI için doğrudan bağlantı (yerelde `DATABASE_URL` ile aynı; production'da Neon unpooled) |
| `AUTH_SECRET` | ✅ | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | prod | DB'deki Instagram token'larını şifreler (base64, 32 bayt). Production'da yoksa Instagram bağlama hata verir; yerelde boşsa düz metne düşer ve uyarır. **Kaybedilirse hesapların yeniden bağlanması gerekir.** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | prod | Google OAuth (boşsa Google girişi kapalı) |
| `BLOB_READ_WRITE_TOKEN` | prod | Vercel Blob |
| `RESEND_API_KEY` / `EMAIL_FROM` | prod | E-posta bildirimi |
| `APP_URL` | prod | Onay linklerinde kullanılan mutlak URL |
| `CRON_SECRET` | prod | Üç cron'un da ortak Bearer sırrı (boşsa hepsi 401 alır) |
| `ALERT_EMAIL` | prod | Sistem uyarılarının gideceği adres — cron çökmesi, yayın hatası, Resend reddi. **Boşsa uyarı hiçbir yere gitmez**, sessizce atlanır ve yalnızca sunucu loguna düşer. Ajans/müşteri bildirimlerinden ayrı bir kutu olmalı. |
| `FURI_API_KEY` / `FURI_API_AGENCY_ID` | — | Makine erişimi (furi otomasyonu). Anahtar en az 32 karakter olmalı, kısa anahtar sessizce değil **loglanarak** devre dışı bırakılır. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | — | Dağıtık rate limiting. Boşsa in-memory fallback devrede. Vercel Marketplace Upstash entegrasyonu `KV_REST_API_*` adlarıyla ekler; kod iki ad setini de tanır. |
| `QUOTA_MAX_CLIENTS` / `QUOTA_MAX_POSTS` / `QUOTA_MAX_POSTS_PER_DAY` / `QUOTA_MAX_PENDING_INVITES` | — | Kota tavanları. Hepsi opsiyonel; tanımsız ya da bozuk değer güvenli varsayılana düşer (bozuk env ajansı kilitlemesin diye). |
| `IG_API_HOST` / `IG_API_VERSION` | — | Instagram Graph API hedefi (testlerde yönlendirmek için) |
| `ENABLE_TEST_AUTH` | — | `1` ise test girişi aktif — **production'da asla** (kod ayrıca `NODE_ENV=production`'da provider'ı hiç eklemez) |

## Testler

```bash
# Test veritabanları (bir kez)
docker exec content-approval-pg psql -U postgres   -c "CREATE DATABASE content_approval_test;" -c "CREATE DATABASE content_approval_e2e;"

npm test                          # vitest: unit + integration (gerçek Postgres'e karşı)
npm test -- src/lib/blob.test.ts  # tek dosya
npm test -- src/app/api/posts     # yol önekiyle bir grup
npm run test:e2e                  # Playwright: 3111 portunda kendi dev sunucusunu açar
npx tsc --noEmit                  # tip kontrolü
```

**Testler gerçek Postgres ister ve otomatik ayağa kalkmaz.** Konteyner durmuşsa
(`docker start content-approval-pg`) `vitest.global-setup.ts` tek satır kod okumadan
patlar — `prisma db push` bağlanamaz. Integration testleri tek DB paylaştığı için
dosyalar sırayla koşar (`fileParallelism: false`).

Şifreleme testlerde **açık** koşar: anahtarsız koşmak tüm entegrasyon testlerinin düz
metin yolundan geçmesi, yani asıl kullanılan yolun hiç denenmemesi demekti.

Kapsam: token üretimi/expiry, rate limit eşiği, validasyon, e-posta hata toleransı,
cross-agency erişim reddi (IDOR), transaction rollback, çifte karar yarışı, yayın kilidi,
zamanlanmış yayın, üyelik çözümü ve davet kabulü, kota tavanları, revizyon turu,
süresi dolmuş/geçersiz token, boş durumlar ve tam e2e akışı (giriş → müşteri → post →
incognito onay → dashboard doğrulama, double-submit dahil).

## Deploy (Vercel)

Proje GitHub'a bağlıdır: **`master`'a merge → production**, PR → preview. Elle deploy
gerekmez (`vercel deploy --prod` yine de çalışır). Postgres, Vercel Marketplace üzerinden
Neon'dur (`DATABASE_URL` pooled, `DATABASE_URL_UNPOOLED` migration için).

> **⚠ Merge = prod şema göçü.** `vercel-build` = `prisma migrate deploy && next build`,
> yani master'a merge edilen bir migration **elle hiçbir şey yapılmadan** prod
> veritabanına uygulanır; ayrı bir "deploy et" adımı yok. Şema göçü içeren bir PR'ı merge
> etmeden önce boş bir DB'de **ve prod'a benzeyen veriyle** sına — veri göçü (backfill)
> gerektiren bir migration boş DB'de sorunsuz görünüp prod'u kırabilir.

> **Env değişikliği çalışan deployment'ı etkilemez.** `vercel env add` sonrası mevcut prod
> eski değerlerle çalışmaya devam eder; `vercel redeploy <deployment-url>` gerekir. Ayrıca
> `env add` bu projede varsayılan olarak **Sensitive** ekler ve sensitive bir değişkenin
> değeri bir daha geri okunamaz — sır olmayan değerlerde `--no-sensitive` ver, sonra
> `vercel env pull` ile değeri geri okuyarak doğrula.

### Cron'lar

`vercel.json` üç günlük iş tanımlıyor; üçü de **aynı `CRON_SECRET`** ile korunur
(Vercel bütün cron'lara aynı Authorization başlığını gönderir; ikinci bir sır
yönetilecek bir sır daha olurdu). Sır tanımlı değilse endpoint'ler her isteğe 401
döner — bu bilinçli: sırsız bırakılmış bir token yenileme uç noktası herkese açık olurdu.

| Saat (UTC) | Yol | Ne yapar |
|---|---|---|
| 03:00 | `/api/cron/refresh-instagram-tokens` | Süresi dolmaya yaklaşan (≤ 20 gün) Instagram token'larını uzatır |
| 05:00 | `/api/cron/publish-scheduled` | `publishAt` zamanı gelmiş, onaylanmış postları yayınlar |
| 09:00 | `/api/cron/pending-reminders` | 2 gündür bekleyen posta müşteriye hatırlatma; linki ölmüş bekleyen post için ajansa bildirim |

Hatırlatmalar post başına **tek seferlik** (`Post.reminderSentAt` / `expiryNoticeSentAt`) —
cron her gece koştuğu için spam koruması bu alanlardır.

> **⚠ Hobby planı cron'ları günde bire sınırlıyor.** Saatlik/dakikalık desenler deploy
> sırasında reddediliyor ve tanımlı tek koşu da dakika hassasiyetinde değil (o saat içinde
> herhangi bir an, ±59dk). Üç cron'un da günlük olmasının sebebi budur.
> **Sonuç:** zamanlanmış yayının gerçek çözünürlüğü "en iyi saatte yayınla" değil,
> **±24 saat isabet**. Kod sınırı değil, plan sınırı — Pro'ya geçilirse `vercel.json`'daki
> tek satır saatlik desene çevrilir.

`instagramTokenExpiry` **boşsa** yenileme cron'u o müşteriyi `skip` sayar ve token hiç
yenilenmez. Instagram bağlarken bitiş tarihi de girilmeli.

Cron koşuları Vercel → Project → Cron Jobs ekranından izlenir.

## Mimari

```
[Ajans tarayıcısı] ──Google OAuth──▶ [NextAuth v5, JWT]
                                     └─ googleId → AgencyMember → session.agencyId
[Ajans tarayıcısı] ──▶ /dashboard, /clients, /settings   (session + getScopedDb)
                       /api/clients, /api/posts, /api/agency/members
                                     └─▶ Vercel Blob (görsel) · Resend (e-posta)
[Müşteri, girişsiz] ──▶ /approve/[token]                 (public, rate limit, token+expiry)
                        /api/approve/[token]             (WHERE status='pending' + audit)
                                     └─▶ onay ise publishApprovedPost() → Instagram
[furi (makine)] ──Bearer FURI_API_KEY──▶ /api/posts               (post oluşturma)
                                        /api/clients/[id]/instagram-token  (token çekme)
[Vercel Cron] ──Bearer CRON_SECRET──▶ /api/cron/*        (yenileme · yayın · hatırlatma)
                                     └─▶ Postgres (Neon)
```

**Anlaşılması zor iki ayrım:**

- **Onay ≠ yayın.** `Post.status` müşterinin kararı, `Post.publishStatus` Instagram tarafı.
  Yayın, onay transaction'ı commit olduktan **sonra** ayrı adımda denenir — yayın patlarsa
  onay yerinde kalır. Yayının üç tetikleyicisi var (onay yolu, zamanlanmış cron, onay
  sayfasındaki "tekrar dene") ve üçü de aynı koşullu UPDATE kilidinden geçer.
- **Üyelik yalnızca auth katmanında çözülür.** `AgencyMember` çok kullanıcılı ajansı
  getirdi ama `session.agencyId` düz bir string olarak kaldı; aşağı akıştaki tüm sorgular
  ve IDOR koruması (`getScopedDb`) bundan habersiz çalışmaya devam ediyor.

## Operasyon notları

Proje tamamen ücretsiz katmanlarda çalışır (Vercel Hobby · Neon free · Upstash free · Resend free) — boşta dururken ücret üretmez ve kendiliğinden yayından düşmez. Bilinmesi gerekenler:

- **Hata izleme e-postayla:** Dış servis (Sentry vb.) yok; cron çökmesi, yayın hatası ve Resend reddi `ALERT_EMAIL`'e düşer. **Bu değişken tanımlı değilse uyarı hiçbir yere gitmez.** Uyarı fırtınası bastırması process-içi bir `Map` ile yapılıyor; serverless'ta instance'lar arasında paylaşılmadığı için soğuk başlangıçta aynı hata için birden fazla mail gelebilir.
- **Soğuk başlangıç:** Neon compute boşta uykuya geçer; uzun aradan sonra ilk istek 1-2 sn yavaş açılır. Arıza değildir.
- **Dayanıklılık:** Resend erişilemezse post oluşturma yine çalışır (e-posta loglanıp atlanır); Upstash erişilemezse rate limit in-memory fallback'e düşer. Çekirdek onay akışı yalnızca Vercel + Neon ile ayakta kalır.
- **Google OAuth:** Consent screen "Testing" modundayken yalnızca Test users listesindeki hesaplar giriş yapabilir. Gerçek kullanıcılar için Google Cloud Console'dan **Publish app** gerekir (yalnızca e-posta/profil scope'u kullanıldığından doğrulama süreci yoktur).
- **⚠ Girişi her zaman canlı alias üzerinden yap:** `https://content-approval-saas.vercel.app`. `AUTH_URL`/`NEXTAUTH_URL` tanımlı değil ve NextAuth `trustHost: true` ile callback adresini **isteğin geldiği host'tan** türetiyor. Deployment'a özel bir URL'den (`content-approval-saas-<hash>-....vercel.app`) girersen `redirect_uri` o host olur, Google'da kayıtlı olmadığı için **`Hata 400: redirect_uri_mismatch`** alırsın. Bu URL'ler her deploy'da değiştiği için Console'a eklenmeleri de mümkün değil. Alias'tan girildiğinde üretilen adres `https://content-approval-saas.vercel.app/api/auth/callback/google`'dır ve Console'da kayıtlıdır.
- **Domain bağımlılığı:** `enesmemduhoglu.tech` yenilenmezse yalnızca e-posta gönderimi kırılır — site `vercel.app` adresinde yaşamaya devam eder. Resend'in DNS kayıtları (SPF/DKIM/DMARC + `_dmarc`) domain'in DNS'inde durur.
- **Instagram token'ı artık tek kaynaktan dağıtılıyor.** Eskiden aynı token'ın iki kopyası vardı (SaaS'ta `Client.instagramAccessToken`, furi'de kendi env değişkeni) ve ikisini senkron tutan bir şey yoktu: cron SaaS kopyasını yenileyince furi'ninki sessizce bayatlıyordu. Çözüm `/api/clients/[id]/instagram-token` — furi token'ı her çalışmada buradan çeker, kendi kopyasını hiç tutmaz. **furi tarafında `IG_ACCESS_TOKEN` env'i kalmışsa kaldırılmalı**, yoksa eski tuzak geri döner.
- **Geliştirmeye geri dönüş:** `docker start content-approval-pg` → `npm run dev`. Deploy: `vercel deploy --prod` (migration'lar `vercel-build` ile otomatik uygulanır).

## Yol haritası

Bkz. **[TODOS.md](TODOS.md)** — bu deponun karar günlüğü. Kapanmış işler, **bilinçli
kapsam dışı** bırakılan maddeler, bilinen sınırlar ve doğrulama yöntemleri orada.
Bir tasarım kararını sorgulamadan önce oraya bak; çoğu "neden böyle yapılmamış"
sorusunun cevabı yazılı.

Güvenlik (S1–S9) ve ürün (F1–F13) listelerinin tamamı kapandı. Açık kalanlar bilinçli
kapsam dışı: toplu reddetme, batch onayda özet bildirim, video/Reels ve Instagram dışı
platformlar, revizyon bekleyen posta hatırlatma, zamanlanmış yayın patlarsa otomatik
tekrar deneme.
