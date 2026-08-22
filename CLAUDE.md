# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Dil

**Kod yorumları, commit mesajları ve PR açıklamaları Türkçe.** Yorumlar "ne yaptığını"
değil **"neden böyle yaptığını"** anlatır — mevcut kodun yoğunluğuna ve üslubuna uy.
Alt-agent'lara görev verirken bu kuralı aktar.

## Komutlar

```bash
npm run dev                      # http://localhost:3000
npm test                         # vitest — GERÇEK Postgres'e karşı koşar
npm test -- src/lib/blob.test.ts # tek dosya
npm test -- src/app/api/posts    # yol önekiyle bir grup
npm run test:e2e                 # Playwright, kendi dev sunucusunu 3111'de açar
npx tsc --noEmit                 # tip kontrolü
npm run build                    # prod build (deploy öncesi mutlaka)
```

**Testler Docker'da Postgres ister ve otomatik ayağa kalkmaz.** Konteyner yoksa
`vitest.global-setup.ts` tek satır kod okumadan patlar:

```bash
docker run -d --name cas-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=content_approval_test -p 5455:5432 postgres:16-alpine
```

Integration testleri tek DB paylaşır; `fileParallelism: false` bu yüzden.

## Değişmezler (yeni kod bunlara uymalı)

**IDOR — `getScopedDb(session)`.** Route handler'lar Client/Post/AgencyMember için
**asla ham `db.*` çağırmaz**; `src/lib/scoped-db.ts` her sorguya `agencyId` filtresini
enjekte eder. Yeni bir sorgu tipi gerekiyorsa oraya metot ekle, route'ta ham Prisma
kullanma — filtre unutulabilecek her yer yeni bir açık demektir.

**`session.agencyId` düz bir string olarak kalır.** F6 çok kullanıcılı ajansı
`AgencyMember` ile getirdi ama üyelik çözümü **yalnızca auth katmanında** yapılıyor
(`src/lib/auth.ts` jwt callback: `googleId → AgencyMember → agencyId`). Aşağı akıştaki
~78 çağrı yeri bundan habersiz. Bu sözleşmeyi bozma; bozmak IDOR korumasının dayandığı
zemini dağıtır.

**Yarış koruması koşullu UPDATE ile.** Karar değiştiren her yol
`updateMany({ where: { ...beklenen durum } })` kullanır ve `count === 0` ise 409 döner
(onay/red: `status: 'pending'`; yayın kilidi: `publishStatus IN (...)`). Önce-oku-sonra-yaz
yapma.

**E-posta yalnızca `email.ts > gonder()` üzerinden.** Resend SDK v4 API hatalarında
**throw etmez**, `{ data, error }` döner; dönüşü okumayan çağrı reddedilen her gönderimi
iz bırakmadan yutar. Bu depoda tam olarak bu yüzden iki gün mail gitmedi.
`resend.emails.send`'i doğrudan çağırma.

**Sırlar şifreli ve loglardan ayıklanmış.** `Client.instagramAccessToken` AES-256-GCM ile
`enc:v1:` önekli yazılır (`src/lib/crypto.ts`). Log ve hata metinleri sır taşımaz —
`IGError.report()` ve `refreshInstagramToken`'daki `safeDetail` desenlerine bak.

**Uyarılar akışı düşüremez.** `src/lib/alerts.ts > sendAlert()` hiçbir koşulda throw
etmez; bir uyarının patlaması cron'u ya da yayını çökertmemeli.

**Mutasyon route'larında `checkOrigin`** (`src/lib/origin.ts`, CSRF ikinci katmanı).
API anahtarıyla gelen makine yolu muaftır — tarayıcılar cross-site isteklerde
`Authorization` başlığını otomatik eklemez.

## Mimarinin anlaşılması zor kısımları

**Onay ≠ yayın.** `Post.status` müşterinin kararı, `Post.publishStatus` Instagram tarafı.
Onay transaction'ı commit olduktan **sonra** ayrı adımda yayın denenir; yayın patlarsa
onay yerinde kalır. `publishApprovedPost` hiçbir zaman throw etmez.

**Üç yayın tetikleyicisi var:** onay yolu (anında), `publish-scheduled` cron'u
(`publishAt` geçmişse), ve onay sayfasındaki "tekrar dene". Üçü de aynı koşullu UPDATE
kilidinden geçer — tek kazanan garanti.

**Makine yolu (furi).** Ayrı bir repodaki bulut rutini `Authorization: Bearer FURI_API_KEY`
ile post oluşturuyor ve `/api/clients/[id]/instagram-token`'dan token çekiyor. Anahtar
yalnızca `agencyId` üretir (`src/lib/api-key.ts`), sorgular yine `getScopedDb` üzerinden
gider. Panel yolunu değiştirirken makine yolunu da kontrol et.

**Mükerrer yayın kontrolü benzersizlik kısıtı DEĞİL.** furi "yayınlandı sonra silindi"
durumunda içeriği bilerek havuza geri döndürüyor, yani aynı `externalRef`in ikinci kez
gönderilmesi meşru bir kurtarma yolu. Kod tek soru sorar: *içerik şu an canlıda mı?*
`(agencyId, externalRef)` üzerine `@@unique` koymak bu yolu kalıcı olarak kırar.

## Tuzaklar

**`.env.local` iki ayrı veritabanı adresi tutuyor:** `DATABASE_URL` → localhost:5455
(yerel), `POSTGRES_URL` → prod Neon. Prisma varsayılanıyla bağlanan bir betik prod'a
değil yerele düşer. `scripts/` altındaki betikler bu yüzden bağlandıkları hostu sorgudan
önce doğrular.

**Merge = prod şema göçü.** `vercel-build` = `prisma migrate deploy && next build`.
Master'a merge edilen migration elle hiçbir şey yapılmadan prod'a uygulanır; ayrı bir
"deploy et" adımı yok. Şema göçü içeren PR'ı merge etmeden önce boş DB'de **ve prod'a
benzeyen veriyle** sına — veri göçü (backfill) gereken bir migration boş DB'de sorunsuz
görünüp prod'u kırabilir.

**`prisma migrate diff` yanlış bayrakla yardım metni basıp çıkış kodu 0 döner.** Çıktıda
gerçekten `No difference detected` yazdığını gör; çıkış koduna güvenme.

**Vercel'de `Sensitive` işaretli env'in DEĞERİ geri okunamaz** — `env pull` yer tutucu
yazar. Sır olmayan değerleri `vercel env add --no-sensitive` ile ekle (varsayılan
Sensitive'dir) ve `env pull` ile geri okuyarak doğrula. Env değişikliği **çalışan
deployment'ı etkilemez**; `vercel redeploy <url>` gerekir.

**Vercel Hobby cron'ları günde bire sınırlı** ve tetikleme saati ±59dk oynar. Üç cron'un
da günlük olmasının sebebi bu; zamanlanmış yayının (`publishAt`) gerçek çözünürlüğü
±24 saattir. Kod sınırı değil, plan sınırı.

**Mailler iki AYRI kutuya gidiyor:** onay maili müşteriye (`Client.email`), ajans
bildirimleri iş sahibine (`Agency.email`), sistem uyarıları `ALERT_EMAIL`'e. "Mail
gitmiyor" teşhisini gelen kutusuna bakarak değil, `/api/posts` yanıtındaki
`emailSent` / `emailError` alanlarına bakarak kur.

**Instagram yayını yavaş:** `POST /{ig}/media` görseli senkron indirdiği için slayt başına
~8.5 sn. Karusel container'ları bu yüzden **paralel** oluşturulur; sıralı yapılırsa 60 sn
Vercel tavanı aşılır. Toplu yayının yapılmama sebebi de budur.

**`instagramTokenExpiry` boşsa otomatik yenileme HİÇ çalışmaz** — cron bitiş tarihi
olmayan müşteriyi `skip` sayar. Instagram bağlarken bitiş tarihi de girilmeli.

**Düz metin token'ı şifreliye çevirirken betiği değil production'ı kullan.** Panelden
Instagram'ı bir kez yeniden bağlamak prod'un kendi anahtarıyla şifreler; betik yerel
anahtarı kullanır ve anahtarların aynı olduğu kanıtlanamaz (yukarıdaki Sensitive maddesi).

**`next → sharp/postcss` audit uyarısı yanıltıcı.** Düzeltmesi Next 16'ya semver-major
sıçrama; proje `next/image` kullanmıyor, `sharp` istek yoluna girmiyor, `postcss` build
zamanı. Güvenlik gerekçesiyle Next 16'ya koşma.

## Belgeler

**`TODOS.md` bu deponun karar günlüğü** — kapanmış işler, bilinçli kapsam dışı bırakılan
maddeler, bilinen sınırlar ve ölçüm yöntemleri orada. Bir tasarım kararını sorgulamadan
önce oraya bak; çoğu "neden böyle yapılmamış" sorusunun cevabı yazılı. İş bitirdiğinde
güncelle.

`README.md` ürün ve kurulum anlatır ama Faz E–I (kota, zamanlanmış yayın, ekip üyeleri,
revizyon turu) sonrası bazı bölümleri bayat — çelişki halinde `TODOS.md` ve kod esastır.
