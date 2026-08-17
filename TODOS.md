# TODOS

Son güncelleme: 2026-08-17 (güvenlik turu — S2 + S4 kapatıldı).
Canlı: https://content-approval-saas.vercel.app · **Depo artık private.**

**Açık PR yok, açık issue yok.** #21–#23, #28–#32 merge edildi; `master` = `origin/master`
ve **prod'a deploy edildi** (`content-approval-saas.vercel.app` alias'ı #32'nin
deployment'ında, canlı doğrulandı).
Prod envanteri (2026-08-17, ölçüldü): **3 ajans / 1 müşteri / 6 post** — çöp veri kalmadı.

Kod tabanı baştan sona okunup güvenlik açıkları (S1–S9) ve ürün boşlukları (F1–F13)
"Açık işler" altına işlendi. Ardından **sömürülebilir olan iki madde (S2, S4) kapatıldı**
ve bu belge açık bir açık listesi taşıdığı için **depo private'a alındı** — ayrıntı
"Tamamlananlar → 2026-08-17 güvenlik turu"nda.

---

## Açık işler

### Elle yapılması gerekenler (repo yapamaz)

- [ ] **Boş test ajanslarını sil** — betik hazır, koşulmayı bekliyor (düşük öncelik).
      22 Temmuz'dan kalma iki ajans prod'da duruyor ve **tamamen boş** (post=0, client=0):
      `Enes Memduh` (`cmrw9cu730000l404sekzspv4`) ve `enes can` (`cmrwa781m0001ky04liyy3f5d`).
      Kardeş betik `prod-test-verisi-temizligi.mjs` kural gereği `Agency`'ye hiç dokunmuyor,
      bu yüzden ayrı betik yazıldı: **`scripts/bos-ajans-temizligi.mjs`** (PR #28).
      Dry-run prod'a karşı koşuldu, iki ajans da "boş ve teyitli" çıktı.
      *Çalıştır:* `node scripts/bos-ajans-temizligi.mjs --apply`
      *Emniyet zinciri:* hedefler **sabit id listesi** (betik başka ajans silemez),
      canlı ajans `Enes MEMDUHOĞLU` hem id hem ad ile kara listede ve kontrol üç ayrı
      noktada, silme tek transaction içinde ve **transaction İÇİNDE** ad/kara liste/post/
      client yeniden doğrulanıyor, `information_schema`'dan FK haritası okunup şemaya
      yeni bağlı tablo eklenmişse betik duruyor.
      *Bilinmesi gereken:* betiğin okuduğu `FURI_API_AGENCY_ID` **yerel** `.env.local`'dan
      geliyor ve orada dev değeri (`dev-agency-a`) duruyor — prod'daki hiçbir ajansla
      eşleşmiyor, betik bunu yüksek sesle uyarıyor. Yani o teyit tek başına anlamsız;
      asıl koruma kara liste. Prod değeri (Vercel env) kayda göre
      `cmsw2ajnq0000jm04d6m9puei` = `Enes MEMDUHOĞLU`, yani silinecek ikisi furi'ye
      bağlı değil — istersen `--apply` öncesi Vercel'den bir kez daha bak.
      *Yan etki:* `Agency.googleId` unique; bu iki kayıt silinince o Google hesapları
      tekrar giriş yaparsa sıfırdan yeni ajans oluşur. Beklenen davranış.


### Temizlik

- [ ] **Doğrulama test postunu sil** — panelde `test/bildirim-dogrulama` adlı,
      `status: rejected` bir post duruyor. 2026-08-17 akşamı bildirim zincirini canlıda
      uçtan uca ölçmek için oluşturuldu ve **hemen reddedildi** (red asla yayın yapmaz,
      yani Instagram'a hiçbir şey gitmedi). İşi bitti, silinebilir. Düşük öncelik.

### Bilinçli kapsam dışı

- [ ] **Toplu onayda (`/batch`) ajans bildirimi yok** — #32 tekil onay/red yolunu
      kapsıyor, batch'i bilerek kapsamadı: o yol zaten yayın yapmıyor (aşağıdaki
      "Toplu onay yayın yapmıyordu" maddesi) ve her post için ayrı mail atmak istenmez.
      Batch yeniden ele alınırsa tek bir özet bildirim mantıklı olur.

- [ ] **Toplu reddetme** — reddetme sebebi post başına anlamlı olduğu için toplu onayın
      simetriği yapılmadı. Yeniden değerlendirilirse "ortak sebep" alanı gerekir.

### Güvenlik (2026-08-17 inceleme turu)

Kod okunarak yapılan tur. **Sömürülebilir olan iki madde (S2, S4) kapatıldı** — aşağıda
"Tamamlananlar"da. Kalanlar ya derinlemesine savunma ya da koşula bağlı; hiçbiri bugün
sömürülebilir değil. Temiz çıkan alanların listesi "Bilinmesi gerekenler"de —
yeniden taranmasın.

- [ ] **S1 · Yüksek — Instagram token'ları DB'de düz metin.**
      `prisma/schema.prisma:37`, `Client.instagramAccessToken`.
      Bu bir uygulama sırrı değil, **müşterinin kimlik bilgisi**: hesabına yayın yapma
      yetkisi. Neon dump'ı, bir yedek ya da Prisma query logging'in açılması doğrudan
      hesap ele geçirmeye çıkar ve bedelini müşteri öder.
      *Düzeltme:* uygulama katmanında AES-256-GCM, yeni `src/lib/crypto.ts` +
      `ENCRYPTION_KEY` env. Yazma noktaları sayılı (`scoped-db.ts > updateInstagram`,
      cron'daki `db.client.update`), okuma noktaları da (`findInstagramCredentials`,
      cron, `publish-post.ts`) — dolayısıyla dar bir değişiklik.
      *Kesintisiz geçiş:* `enc:v1:` öneki. Önek yoksa değer düz metin kabul edilip okunur,
      her yazmada şifreliye döner; ayrı migration betiği gerekmez.
      *Dikkat:* furi token'ı `GET /api/clients/[id]/instagram-token` ile çekiyor —
      o uç nokta **çözülmüş** token döndürmeye devam etmeli, yoksa furi sessizce kırılır.

- [x] **S2 — kapatıldı.** Bkz. "Tamamlananlar → 2026-08-17 güvenlik turu".

- [ ] **S3 · Orta — bağımlılıklarda 8 high seviye açık.** (`npm audit --omit=dev`)

      | Paket | Sorun | Çözüm |
      |---|---|---|
      | `@vercel/blob@1.x` → `undici` | request smuggling, CRLF injection, response queue poisoning | `@vercel/blob@2.8.0` (semver-major, ama kullanım yüzeyi tek `put()` çağrısı) |
      | `prisma` → `@prisma/config` → `deepmerge-ts` | stack exhaustion | `npm audit fix`, breaking değil |
      | `nanoid` | sonsuz döngü | `npm audit fix`, breaking değil |

- [x] **S4 — kapatıldı.** Bkz. "Tamamlananlar → 2026-08-17 güvenlik turu".

- [ ] **S5 · Orta — sır dağıtan uç noktada rate limit ve erişim kaydı yok.**
      `src/app/api/clients/[id]/instagram-token/route.ts` ham token döndüren tek yol.
      Kimlik doğrulama sabit zamanlı, `Cache-Control` düşünülmüş, ajans kapsamı yerinde —
      ama **rate limit yok** (diğer public yollarda var) ve **hiçbir erişim kaydı yok**.
      `FURI_API_KEY` sızarsa token'ın ne zaman, kaç kez çekildiği hiçbir yerde görünmez.
      *Düzeltme:* mevcut `checkRateLimit` yeniden kullanılır; log satırı token içermeden
      `clientId` + zaman yazar.

- [ ] **S6 · Düşük-Orta — görsel doğrulaması istemci beyanına güveniyor.**
      `src/lib/blob.ts:15-26` kararı `file.type` ile veriyor (istemci gönderir),
      magic-byte kontrolü yok.
      *Etkisi sınırlı:* Blob ayrı origin'de servis ediliyor ve uzantı `.jpg/.png/.webp`
      olarak zorlanıyor, yani depolanmış XSS uygulama origin'ine ulaşamaz. Asıl kazanç
      güvenlikten çok teşhiste: sahte MIME'lı dosya bugün ancak **yayın anında** `failed`
      olarak patlıyor; ilk baytlardan imza kontrolü hatayı yükleme anına çeker.

- [ ] **S7 · Düşük — `x-forwarded-for`'un ilk değerine güveniliyor.**
      `src/lib/rate-limit.ts:92-97`. Vercel bu başlığı kendi yazdığı için **bugün
      sömürülebilir değil**. Ama `ApprovalAudit.ip` bir onayın *kanıtı* olarak saklanıyor;
      proje Vercel dışına taşınır ya da araya bir proxy girerse hem rate limit hem o kanıt
      aynı anda sahteleşir. `x-vercel-forwarded-for`'a öncelik vermek tek satır.

- [ ] **S8 · Düşük/bilgi — CSRF koruması yalnızca SameSite'a bağımlı.**
      NextAuth v5 session cookie'si `SameSite=Lax`; cross-site POST'ta cookie gitmiyor,
      yani **şu an sömürülebilir değil**. Ancak `/api/posts` ve `/api/agency`
      `multipart/form-data` kabul ediyor (CORS'un "basit istek"i), dolayısıyla tek savunma
      bu tek katman. `Origin` başlığı kontrolü ucuz bir ikinci katman olur.

- [ ] **S9 · Düşük/uyumluluk — veri silme yolu yok.** API'de hiç `DELETE` yok; ne müşteri
      ne post silinebiliyor. KVKK/GDPR "silme hakkı" bugün elle SQL demek. Yukarıdaki
      "Doğrulama test postunu sil" maddesinin elle iş olarak durmasının sebebi de bu.
      **F2 ile aynı kök** — orada çözülür.

### Ürün boşlukları (2026-08-17 inceleme turu)

Aynı turun ürün tarafı. Hiçbiri başlanmadı; sıralama "temel akışın deliği mi, büyüme
maddesi mi" ayrımına göre.

**Temel akışın delikleri — yüksek değer, düşük maliyet**

- [ ] **F1 · Onay linki yenilenemiyor.** `APPROVAL_LINK_TTL_DAYS = 7` dolunca post kalıcı
      kilitleniyor: yeni link üretecek ne API ne arayüz var, müşteri tatildeyse iş durur.
      Ekle: `POST /api/posts/[id]/relink` + panelde "Yeni link gönder".
      Mevcut `generateApprovalToken` / `approvalLinkExpiry` aynen yeniden kullanılır.
- [ ] **F2 · Post/müşteri silinemiyor, düzenlenemiyor.** Yanlış caption ya da yanlış
      görselle oluşan postu geri almanın yolu yok — bir onay aracında tuhaf boşluk.
      `DELETE /api/posts/[id]` (yayınlanmışı koru), `PATCH` (yalnızca `pending` iken
      caption), `DELETE /api/clients/[id]` (postu varsa reddet). S9'u da kapatır.
- [ ] **F3 · Hatırlatma yok.** Post `pending`'de sonsuza kadar durabiliyor; ne müşteriye
      ikinci mail ne ajansa "3 gündür bekliyor" uyarısı. Cron altyapısı (`vercel.json` +
      `CRON_SECRET` + `bearerToken`/`secretsMatch`) zaten kurulu — ikinci bir cron işi,
      yeni altyapı gerekmiyor.
- [ ] **F4 · `ApprovalAudit` hiçbir yerde okunmuyor.** Yazılıyor ama ne panelde ne API'de
      görünüyor. README'nin öne çıkardığı "karar IP ve zaman damgasıyla kayıt altında"
      vaadinin arayüzde karşılığı yok — veri ölü duruyor. Post detayında küçük bir zaman
      çizelgesi yeter.
- [ ] **F5 · `emailSent` panele yansımıyor.** #31 alanı API yanıtına koydu ama dashboard
      göstermiyor ve "maili tekrar gönder" butonu yok. Aşağıdaki "mailler iki ayrı kutuya
      gidiyor" tuzağının kalıcı çözümü bu: durumu `Post` üzerinde sakla, rozetle göster.

**SaaS eksikleri — şema/ürün kararı gerektirir**

- [ ] **F6 · Ajans başına tek kullanıcı.** `Agency.googleId @unique`; ekip üyesi davet
      edilemiyor, oysa küçük ajanslarda bile 2-3 kişi çalışıyor. `AgencyMember` tablosu
      gerekir. **Erken yapılmazsa pahalılaşır** — her `session.agencyId` kullanımı dolaylanır.
- [ ] **F7 · Kota/plan yok.** Sınırsız müşteri, sınırsız post, post başına 10 MB × 10 görsel.
      Ücretsiz katmanlarda duruyor ama tek kötü niyetli hesap Blob ve Resend kotasını
      tüketebilir. En azından ajans başına kaba tavanlar.
- [ ] **F8 · Zamanlanmış yayın yok.** Onay = anında yayın. Sosyal medya ajansı aracında
      "en iyi saatte yayınla" temel beklenti. `Post.publishAt` + cron; `publishApprovedPost`
      zaten idempotent kilide sahip olduğu için yayın kodu olduğu gibi kullanılabilir.
- [ ] **F9 · Yalnızca Instagram, yalnızca görsel.** Reels/video yok
      (`ALLOWED_IMAGE_TYPES` üç format), başka platform yok. Bilinçli kapsam olabilir ama
      yol haritasında adı geçmeli.
- [ ] **F10 · Revizyon turu yok.** Müşteri reddedince akış bitiyor; "şu cümleyi değiştir"
      demek için ajans yeni post açmak zorunda ve geçmiş kopuyor. Sürüm + yorum zinciri,
      ürünün asıl farklılaşma noktası olurdu.

**Operasyon**

- [ ] **F11 · Hata izleme yok.** Her şey `console.error` ile Vercel loglarına gidiyor ve
      kimseye ulaşmıyor: cron'un sessizce patlaması, Resend'in reddetmesi, yayın hataları
      ancak biri bakarsa görünür. "İki gündür mail gitmiyor" olayının tekrar etmemesinin yolu.
- [ ] **F12 · `/api/health` yok.** Uptime/canary izlemesi için uç nokta yok.
- [ ] **F13 · Blob dosyaları asla silinmiyor.** Sınırsız birikim; F2 ile birlikte ele alınmalı.

**Yapılırsa önerilen sıra:** Faz A (S2 → S3 → S4 → S5 → S7, hepsi küçük) · Faz B (S1 token
şifreleme, tek başına PR) · Faz C (F1 + F2 + F5, tek "post yönetimi" PR'ı) · Faz D
(F3 + F4 + F11, görünürlük turu) · sonra F6/F7/F8 ayrı ayrı tartışılır.

---

## Bilinmesi gerekenler

**Güvenlik turunda DENETLENDİ ve temiz çıktı — bir sonraki tur bunları yeniden taramasın.**
2026-08-17 incelemesinde tek tek okundu ve doğru kurulmuş bulundu:
**IDOR** (`getScopedDb` her route'ta, makine anahtarı yolu dahil — anahtar yalnızca
`agencyId` üretiyor), **yarış koşulları** (onay/red ve toplu onay `WHERE status='pending'`
koşullu UPDATE; yayın kilidi `publishStatus IN ('idle','failed')` ile aynı desende),
**token entropisi** (`randomUUID`, 122 bit — brute-force anlamsız), **sabit zamanlı sır
karşılaştırma** (`secretsMatch`, iki taraf da SHA-256'dan geçirilerek uzunluk sızıntısı da
kapatılmış), **XSS** (`dangerouslySetInnerHTML` / `eval` hiç yok; e-postada `escapeHtml`,
marka renginde hex regex), **token'ın yanıtlardan ayıklanması** (`ClientView` +
`findManyWithRelations`'ın client alanlarını düşürmesi) ve **loglarda sır redaksiyonu**
(`IGError.report()`, `refreshInstagramToken`'daki `safeDetail`, cron yanıtının yalnızca
sayı taşıması). Açık bulgular yukarıdaki "Güvenlik" başlığında; bu liste onların dışında
kalan ve **tekrar bakılması gerekmeyen** alanları kaydediyor.

**`npm audit`'teki `next` → `sharp` / `postcss` uyarısı yanıltıcıdır — Next 16'ya koşma.**
Bu iki paket için audit'in önerdiği düzeltme `next@16` (semver-major). Ama `sharp`
(libvips CVE'leri) yalnızca `next/image` üzerinden görsel işlerken istek yoluna girer ve
**bu proje `next/image` kullanmıyor** — her `<img>` üstünde
`eslint-disable @next/next/no-img-element` var, görseller Blob'dan doğrudan servis
ediliyor. `postcss` ise build zamanı. Yani ikisi de çalışan sistemde saldırı yüzeyi
oluşturmuyor; Next 16 yükseltmesi kendi başına planlanmalı, güvenlik gerekçesiyle aceleye
getirilmemeli. Gerçekten kapatılması gerekenler S3'teki üç satır.

**Mailler iki AYRI kutuya gidiyor — "mail gitmiyor" teşhisi bu yüzden yanlış kurulabilir.**
Onay maili **müşterinin** adresine (`Client.email`), ajans bildirimleri **iş sahibinin**
adresine (`Agency.email` = `enesmemduhoglu0@gmail.com`) gider. İkisi de
`eneshan034@gmail.com` **değil**. 2026-08-17'de bu tuzağa düşüldü: `eneshan034` kutusunda
mail görünmeyince "iki gündür onay maili gitmiyor" sonucuna varıldı, oysa mailler
gidiyordu — sadece başka kutuya. Ölçüm bunu net gösterdi: aynı Resend anahtarı ve aynı
`EMAIL_FROM` ile `eneshan034`'e **doğrudan** atılan test maili düştü, uygulamanın
`Client.email`'e attığı mail ise `emailSent: true` dönmesine rağmen orada görünmedi.
*Kural:* bir mailin gidip gitmediğini gelen kutusuna bakarak değil, `/api/posts`
yanıtındaki **`emailSent` / `emailError`** alanlarına bakarak karara bağla.

**Resend SDK'sı (v4) API hatalarında THROW ETMEZ.** `{ data, error }` döndürür. Dönüşü
okumayan bir çağrı, reddedilen her gönderimi iz bırakmadan yutar: post 201 döner, durum
`pending` kalır, log bile çıkmaz. `email.ts > gonder()` bu dönüşü okuyor ve `EmailResult`
üretiyor — **yeni bir mail yolu eklerken `gonder()` üzerinden geç**, `resend.emails.send`'i
doğrudan çağırma. (#31)

**`.env.local` iki ayrı adres tutuyor.** `DATABASE_URL` → **localhost** (Docker, port 5455);
prod Neon adresi **`POSTGRES_URL`** altında. Prisma varsayılanıyla bağlanan bir betik prod'a
değil yerel DB'ye düşer. Prod'a yazmadan önce bağlandığın hostu **doğrula** —
bu tuzak 2026-08-16'da prod temizliği sırasında bir kez yakalandı.
`scripts/prod-test-verisi-temizligi.mjs` (#22) bu doğrulamayı zorunlu adım hâline getirdi:
prod olmayan hosta bağlanılırsa tek sorgu açılmadan `exit 2`.

**`instagramTokenExpiry` boşsa otomatik yenileme HİÇ çalışmaz.** Cron bitiş tarihi olmayan
müşteriyi `skip` sayıyor — yani alan boşsa 2026-10-15 sorunu çözülmüş olmaz, cron sessizce
hiçbir şey yapmaz. Panelden kontrol edilebilir; furi tarafında
`python .claude/skills/insta-yayinla/scripts/ig_token.py --kontrol` bunu
`durum: bilinmiyor` diye raporlar.

**Yayın süresi.** Instagram `POST /{ig}/media` görseli senkron indirdiği için slayt başına
~8.5 sn. Karusel container'ları bu yüzden paralel oluşturuluyor; sıralı yapılırsa 60 sn
Vercel tavanı aşılır. Toplu yayının yapılmama sebebi de bu.

**Deploy.** Proje GitHub'a bağlı (2026-08-17'de bağlandı): master'a merge → production,
PR → preview. Elle deploy gerekmiyor.

**Silinmiş Instagram medyasının hata imzası — canlı veriyle doğrulandı (2026-08-17).**
`dizi/long-story-short`'un iki kaydı prod'da teşhis edildi: `18619576627013761` **silinmiş**,
`18073015358411119` **canlı**. Silinen medya `GET /{media-id}?fields=id` çağrısına şunu
döndürüyor:
```
HTTP 400 · code=100 · error_subcode=33
"Unsupported get request. Object with ID '...' does not exist, cannot be loaded
 due to missing permissions, or does not support this operation"
```
Bu tam olarak #23'teki `isMissingObjectError`'ın aradığı kalıp — yani canlılık kontrolü
uydurma bir imzaya değil, prod'da ölçülmüş gerçek cevaba dayanıyor. Dikkat: Instagram
silinmiş medya için **404 döndürmüyor**, 400 döndürüyor; sadece HTTP koduna bakan bir
kontrol yanılır.

**Mükerrer yayın kontrolü neden benzersizlik kısıtı değil.** furi'nin `esitle.py`'si
"yayınlandı ama sonra Instagram'dan silindi" durumunda içeriği bilerek havuza geri
döndürüyor (`yayinlandi_sonra_silindi`). Yani aynı `externalRef`'in ikinci kez gönderilmesi
**meşru bir kurtarma yolu**. `(agencyId, externalRef)` üzerine `@@unique` koymak ya da
"bu ref daha önce yayınlandı mı" diye bakmak bu yolu kalıcı olarak kırar. #23 bu yüzden
tek bir soru soruyor: *içerik ŞU AN canlıda mı?*

---

## Tamamlananlar

### 2026-08-17 — güvenlik turu (S2 + S4 kapatıldı, depo private'a alındı)

Tetikleyen soru: **"bu açıkları public repoda yayınlamak onları göstermek değil mi?"**
Haklı bir soruydu. Çıkan sonuç: depo public'ti, açıklar açıktı ve tarifi yazılıydı.

- [x] **Depo private'a alındı.** 0 fork / 0 star olduğu için içerik pratikte hiç
      yayılmamıştı. *Neden TODOS'u gitignore'lamak yetmezdi:* içerik yalnızca o dosyada
      değildi — PR #33'ün **diff'i** ve **gövdesi** GitHub'da kalır, force-push sonrası
      kopuk commit'ler SHA ile erişilebilir kalır. Yani geçmişi yeniden yazmak en çok iş,
      en az fayda olurdu; üstelik açıklar yine açık kalırdı. Private + gerçek düzeltme
      seçildi. **Doğrulandı:** hiçbir SIR DEĞERİ hiç sızmamıştı (`CRON_SECRET`,
      `FURI_API_KEY`, Resend/Blob token'ları TODOS'ta yalnızca *adıyla* geçiyor).
      Sızan şey prod id'leri ve iki e-posta adresiydi; onlar da 22 Temmuz'dan beri oradaydı.

- [x] **S2 — test girişi artık production'da var olamaz.** `src/lib/auth.ts` koşulu bir
      ortam değişkenine bırakmıyordu; `NODE_ENV === "production"` mutlak kapı oldu, env ne
      derse desin provider eklenmiyor. Yanlış yapılandırma sessizce yutulmuyor: değişken
      production'da set edilmişse yüksek sesle `console.error` basılıyor ama **kapı yine
      açılmıyor**. Vercel hem preview hem production build'inde `NODE_ENV`'i "production"
      yaptığı için internete açık hiçbir deployment'ta test girişi bulunmuyor.
      *E2E etkilenmedi:* Playwright `next dev` ile koşuyor (`NODE_ENV=development`).
      *Canlı doğrulandı:* `ENABLE_TEST_AUTH=1` **bilerek açıkken** production build'e karşı
      `POST /api/auth/callback/credentials` → `error=Configuration`, `set-cookie` yok,
      `/api/auth/session` → `null`, `/dashboard` → girişe yönlendirdi. NextAuth'un kendi
      logu: `Provider with id "credentials" not found. Available providers: [google]`.
      8 yeni test (`src/lib/auth.test.ts`) bu regresyonu kilitliyor.
      *Test yazarken öğrenilen:* `Credentials()` fabrikası kendisine verilen `id`'yi
      ("test-login") **yok sayıyor**, `id: "credentials"` ile dönüyor — provider'ı `id` ile
      arayan bir test sessizce yanlış şey ölçer. Doğru ayraç `type === "credentials"`.

- [x] **S4 — güvenlik başlıkları eklendi, clickjacking kapatıldı.** `next.config.ts`
      artık `headers()` tanımlıyor: CSP (`frame-ancestors 'none'`), `X-Frame-Options: DENY`,
      `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`,
      HSTS. Asıl kazanç onay sayfası: giriş gerektirmiyor ve "Onayla" doğrudan yayın
      tetiklediği için iframe'lenebilir olması, tek tıkla geri alınamaz bir yayın demekti.
      *Bilinçli gevşeklikler (gerekçeleri dosyada):* `script-src 'unsafe-inline'` — Next.js
      hidrasyonu inline script gömüyor, nonce'a geçmek sırf bunun için `middleware.ts`
      eklemeyi gerektirirdi; `img-src ... https:` — host daraltmak Blob store adı
      değiştiğinde onay sayfasının görselini SESSİZCE kırardı, sunucuda zaten
      `ALLOWED_IMAGE_URL_HOSTS` allowlist'i var. `preload` BİLEREK yok (geri alması zor
      taahhüt). *Canlı doğrulandı:* production build'de altı başlık da yanıtta.

- [x] **272/272 test geçti, `tsc --noEmit` temiz, `next build` başarılı.**

### 2026-08-17 akşamı — bildirim turu (SaaS #31, #32 · furi #4, #5)

Tetikleyen olay: **furi'nin 15:07 zamanlanmış çalışması düştü ve o yuvaya post konmadı.**
Kovalarken iki ayrı gerçek sorun ve bir yanlış teşhis çıktı.

- [x] **`esitle.py` Instagram'a ulaşamayınca tüm akışı düşürüyordu** (furi #4).
      Bulut oturumunun çıkış proxy'si `graph.instagram.com:443` CONNECT'ini politika
      gereği 403 ile kesiyor. Script bunu `IGHatasi` olarak alıp **çıkış kodu 1** ile
      dönüyordu; skill'in "hata olursa dur" kuralı yüzünden Faz 2 hiç çalışmadı.
      Oysa aynı dosya karşılaştırmayı *"opsiyonel, bir emniyet ağı"* diye tarif ediyor ve
      **token alınamadığında** zaten atlayıp devam ediyordu — token alınıp **çağrı
      başarısız olduğunda** tepki farklıydı. İki yol aynı davranışa bağlandı.
      *Sonuç:* bulutta Instagram karşılaştırması hiç çalışmıyor, yani **"defterde var,
      Instagram'da yok" tespiti zamanlanmış çalışmalarda yapılmıyor** — elle silinen post
      kendiliğinden havuza dönmez, `atlananlar`'a elle eklenmeli. Bu kısıt SKILL.md'ye
      yazıldı. Faz 1'in asıl işi (bekleyen postun akıbeti) etkilenmiyor: o bilgi SaaS'ın
      public onay endpoint'inden geliyor ve Instagram'a hiç dokunmuyor.

- [x] **Onay maili sessizce kaybolabiliyordu** (#31). `resend@4` throw etmiyor,
      `{ data, error }` döndürüyor; `email.ts` dönüşü hiç okumuyordu. Reddedilen her
      gönderim iz bırakmadan kayboluyordu — ne log, ne hata, ne uyarı. Testler de eski SDK
      şeklini (`mockResolvedValue({id})`) taklit ettiği için bu yolu hiç kapsamamıştı.
      Artık `{ error }` okunuyor, `EmailResult` dönüyor ve `/api/posts` yanıtına
      **`emailSent` / `emailError`** olarak çıkıyor. Hâlâ throw etmiyor — post oluşturma
      e-postaya bağımlı değil.
      *furi tarafı (#5):* bu alanlar `saas_gonder.py` raporuna `mail_gitti` / `mail_hatasi`
      olarak taşınıyor; `mail_gitti: false` görülürse skill `[FURI-HATA]` maili atıyor.
      Alan yoksa sessiz kalıyor (eski SaaS sürümüne karşı yanlış alarm yok).

- [x] **İş sahibine onay/red bildirimi — hiç yazılmamış özellik** (#32).
      Müşteri onay e-postasını alıyordu, **ajansın akıştan hiç haberi olmuyordu**;
      `approve/[token]/route.ts` içinde `email`/`mail`/`bildir` geçen tek satır yoktu.
      Artık `Agency.email` adresine üç noktada bildirim gidiyor: post onaya gönderilince
      (`[Onay bekliyor]`, içinde müşteriye mail gidip gitmediği + onay linki), onaylanınca
      (`[Onaylandı]`, **yayının akıbeti + permalink**), reddedilince (`[Reddedildi]`,
      gerekçesiyle). Yayın tekrar denemesi de bildiriliyor.
      *Kararlar:* onay bildirimi **yayından sonra** gider — sadece "onaylandı" diyen bir
      mail, yayının patladığını gizlerdi. Bildirim onayı **asla** etkilemez; hata yalnızca
      loglanır, karar ve yayın yerinde kalır (test ediliyor).

- [x] **Canlıda uçtan uca doğrulandı.** #32 merge'i otomatik prod deployment'ı tetikledi
      (`target: production`, alias bağlı). Doğrulama için test postu oluşturulup **hemen
      reddedildi** — red asla yayın yapmadığı için Instagram'a hiçbir şey gitmedi:
      `POST /api/posts → 201, emailSent: true, emailError: none` ·
      `POST /api/approve → 200, {"status":"rejected"}`.

- [x] **"İki gündür onay maili gitmiyor" — yanlış teşhisti, arıza yoktu.**
      Mailler gidiyordu; `eneshan034@gmail.com` kutusuna bakıldığı için görünmüyordu.
      Doğru adresler: onay maili müşteriye, bildirimler `enesmemduhoglu0@gmail.com`'a.
      Ayrıntı ve kural için yukarıdaki "Bilinmesi gerekenler" bölümü.

- [x] **furi token tek kaynak maddesi kapandı** (#29 + furi #3, bu turdan önce merge).
      furi artık `IG_ACCESS_TOKEN` kopyası tutmuyor, token'ı her çalışmada
      `GET /api/clients/[id]/instagram-token` ile SaaS'tan çekiyor — 2026-09-25'teki ilk
      gerçek yenilemede sessizce kırılma riski ortadan kalktı.
      *Kalan elle iş:* furi'nin yerel `.env`'inde `IG_ACCESS_TOKEN` / `IG_USER_ID` satırları
      duruyorsa silinebilir; artık hiçbir yerde okunmuyorlar.

### 2026-08-17 — açık işler turu (PR #21, #22, #23)

- [x] **Apps Script'teki GitHub token'ı — açıkta bir şey kalmamış, panelden teyit edildi.**
      Madde "iptal edildi ama doğrulanamıyor" diye açık duruyordu; script.google.com ve
      GitHub ayarları tarayıcıdan gerçekten kontrol edildi ve **üç doğrulama noktası da
      temiz** çıktı:
      1. **Tetikleyici yok.** "FURI onay tetikleyici" projesi duruyor ama hem global
         "Tetikleyicilerim" hem projenin kendi sekmesi 0 tetikleyici gösteriyor —
         `onayKontrol` çalışmıyor. Kodda `EMEKLI = true` bayrağı da yerinde, yani proje
         kazara tetiklense bile Gmail taramaz.
      2. **Script Property yok.** Proje Ayarları → Komut Dosyası Özellikleri **boş**;
         `FURI_GITHUB_TOKEN` silinmiş.
      3. **GitHub token'ı yok.** `settings/personal-access-tokens` → "No fine-grained
         tokens created" (token fine-grained'di, adı `furi-apps-script`, kapsamı yalnızca
         `furi` reposu + Issues). Classic tokenlar arasında yalnızca ilgisiz bir
         `portfolio site` kaydı var, o da 2025-10-17'de süresi dolmuş.
      Repo tarafı da tekrar tarandı: `ghp_` / `github_pat_` / `FURI_GITHUB_TOKEN` için
      6 eşleşmenin hepsi property **adına** yapılan referans ya da kurulum yer tutucusu —
      gerçek token değeri furi1'de hiçbir yerde yok.
      *Kaydın düzeltmesi:* maddedeki "tetikleyici issue #1 kapatılabilir" adımı da
      geçersiz — `enesmemduhoglu/furi` reposunda hiç issue yok.

- [x] **`CRON_SECRET` Vercel Production'a eklendi (Sensitive)** — cron artık devrede:
      `vercel.json` 03:00'e kurulu, endpoint canlıda, yetkisiz istek 401 dönüyor.
      *Doğrulamanın sınırı:* sırsız istek ile yanlış-sırlı istek **aynı** 401'i döndürüyor
      (bilinçli tasarım), yani değerin sonunda satır sonu olup olmadığı dışarıdan
      anlaşılamıyor. İlk `[cron:ig-token]` loglarına bakmak gerekiyor.
      *Şu anki davranış:* "Furkan Teacher"ın token'ı **2026-10-15'te** doluyor, yani
      `IG_TOKEN_REFRESH_DAYS = 20` penceresinin dışında → cron her gece `skipped:1` dönüyor
      ve hiçbir token'a dokunmuyor (furi bozulmuyor). İlk **gerçek** yenileme ~2026-09-25.

- [x] **"Prod'da çift yayın duruyor" maddesi kapandı — yapacak bir şey yokmuş.**
      Instagram'da `long-story-short`'tan **tek post var**; iki `published` kaydın eskisine
      (`cmsvyzi1w0001ju04qoih8gjp`, medya `18619576627013761`) ait medya silinmiş ve o kaydın
      `igPermalink`'i **zaten `NULL`**. Yeni kayıt (`cmsw1t4mv0001ky046csgssb5`, medya
      `18073015358411119`) canlı ve permalink'i yerinde. Yani DB gerçeği doğru yansıtıyor:
      "yayınlandı, sonra silindi" durumu `publishStatus='published'` + `igPermalink=NULL`
      olarak zaten doğru kodlanmış. Düzeltilecek tutarsızlık çıkmadı.

- [x] **Mükerrer Instagram yayını koruması** — `externalRef` aynı olan kardeş postun
      Instagram'da hâlâ durup durmadığı kontrol ediliyor (`GET /{media-id}?fields=id`).
      Yalnızca **kesin canlı** kardeş varsa yayın durur; silinmişse yayın yapılır
      (kurtarma yolu korunur); kontrol **belirsiz** kalırsa (rate limit, 5xx, ağ) yayına
      izin verilip uyarı loglanır — bu bir emniyet ağı, kapı değil. Yeni `PublishStatus`
      değeri `duplicate` (`failed` değil: `failed` "tekrar dene" yolunu açıyor, oysa
      engellemek istediğimiz tam olarak o). Panelde "Zaten yayında" rozeti ve canlı posta
      link. Ajans izolasyonu korunuyor. (PR #23)

- [x] **Otomatik Instagram token yenileme** — günlük Vercel cron (`vercel.json`, 03:00)
      → `/api/cron/refresh-instagram-tokens`. `CRON_SECRET` ile Bearer + sabit zamanlı
      karşılaştırma (`api-key.ts`'deki mevcut yardımcı export edildi, kopyalanmadı).
      Yenileme penceresi `IG_TOKEN_REFRESH_DAYS = 20` — uyarı eşiğinin (10) iki katı,
      böylece cron ajans hiçbir uyarı görmeden işini bitiriyor ve ~20 deneme hakkı oluyor.
      Süresi zaten dolmuş token ayrı durum: Instagram uzatmıyor, elle yeniden bağlama
      gerekiyor. Bir müşterinin hatası diğerlerini durdurmuyor. Yanıt yalnızca sayı
      taşıyor, `IGError.detail` içinde `access_token` redakte ediliyor. (PR #21)

- [x] **Prod temizlik betiği** — `scripts/prod-test-verisi-temizligi.mjs`, varsayılan
      dry-run, silme yalnızca `--apply` ile. Zorunlu host doğrulaması, tam caption
      eşleşmesi (kör `LIKE` yok), yayınlanmış post asla silinmez, tarih koruması,
      `Agency` asla silinmez. Dry-run prod'a karşı çalıştırıldı, TODOS'taki "6 post"
      iddiası doğrulandı. (PR #22)

- [x] **Prod çöp verisi temizlendi — 2026-08-17'de canlı veriyle doğrulandı.**
      Temizlik betiğinin dry-run'ı artık **0 post** döndürüyor (önceki turda 6'ydı) ve
      hedef ajansların ikisi de boşalmış. "Silindi mi, yoksa başka `agencyId` altına mı
      taşındı" sorusu ajanstan **bağımsız** bir sayımla kapatıldı:
      `caption ∈ [asd, gfh, as, sdf]` → **0 eşleşme**, ve
      `createdAt < 2026-08-01` → **0 post**. Yani 22 Temmuz kalıntısı hiç kalmamış;
      caption'ı değiştirilmiş bir çöp kaydın saklanma ihtimali de tarih taramasıyla elendi.
      *Prod envanteri (2026-08-17):* 3 ajans / 1 müşteri / 6 post. Tek müşteri
      "Furkan Teacher" (IG bağlı), 6 postun hepsi 2026-08-16 sonrası gerçek veri.
      Ajanslardan yalnızca `Enes MEMDUHOĞLU` (`cmsw2ajnq0000jm04d6m9puei`) dolu —
      `FURI_API_AGENCY_ID` bu. Diğer iki ajans boş; ayrı madde olarak açık bırakıldı.

### 2026-08-16 / 17 — Instagram yayını sonrası tur

- [x] **Instagram bağlama arayüzü** — `/clients` satırlarında bağlama alanı
      (`POST`/`DELETE /api/clients/[id]/instagram`). Token `type="password"`,
      `GET /me?fields=user_id` ile doğrulanıp `instagramUserId` otomatik doluyor. (PR #16)

- [x] **Token sızıntısı kapatıldı** — `GET /api/clients` ve `GET /api/posts`
      `instagramAccessToken`'ı ham JSON'da döndürüyordu (ajans kendi müşterisinin token'ını
      tarayıcıda görüyordu; `agencyId` kapsamı olduğu için ajanslar arası sızıntı değildi).
      Client okumaları artık `ClientView`, post ilişkisinde türetilmiş `publishTarget`
      bayrağı var. Canlıda doğrulandı. (PR #16)

- [x] **Token süresi uyarısı** — dashboard'da proaktif şerit. `src/lib/instagram-token.ts`
      tek doğruluk kaynağı (`IG_TOKEN_WARNING_DAYS = 10`); `publish-post.ts` de aynı
      yardımcıyı kullanıyor. İki tonlu: "yakında doluyor" / "doldu → yayın durmuş". (PR #15)

- [x] **Toplu onay yayın yapmıyordu** — yayın hedefli postlar toplu onaydan çıkarıldı.
      Instagram bağlı müşteride batch 409 + "tek tek onaylaman gerekiyor" döner, onay
      sayfasında sebebi açıklanır, panelde onaylanmış-yayınlanmamış postlar "Yayınlanmadı"
      rozetiyle görünür. Sıkışmış eski postlar onay linkindeki "Instagram'a yayınla"
      butonuyla kurtarılabiliyor. (PR #18)

- [x] **Prod test kayıtları temizlendi** — `testclientnoig...` müşterisi ve postu tek
      transaction'da silindi; "Duman testi" postunun 404 veren `igPermalink`'i `NULL`'landı
      (`publishStatus` ve `igMediaId` korundu, post gerçekten yayınlanmıştı). (PR #17)

- [x] **furi Faz 2** — apps-script zinciri `emekli/` altına alınıp `EMEKLI = true` ile devre
      dışı bırakıldı; caption limiti SaaS'ın 2000 sınırına göre düzeltildi; tek bozuk postun
      kuyruğu tıkaması giderildi; `aday_yok` / `uygun_aday_yok` ayrıldı.
      (furi PR #2 — SKILL.md'nin SaaS'a POST atması zaten yapılmıştı)

- [x] **Deploy zinciri onarıldı** — proje 25 gündür GitHub'a bağlı değildi, bütün
      deployment'lar elle alınıyordu; bu yüzden #11–#18 merge edildiği hâlde canlı 22 Temmuz
      kodunda kalmıştı. Bağlantı kuruldu ve webhook preview üreterek doğrulandı.

### 2026-07-22 — v2 kapsamı

- [x] **Çoklu görsel / carousel (D3.3)** — `PostImage` tablosu (veri taşıma migration'ıyla),
      post başına 10 görsele kadar, onay sayfasında scroll-snap carousel, panelde adet rozeti.
- [x] **Ajans markalama (D3.4)** — `/settings`'ten logo + marka rengi; onay sayfası ve
      e-postada uygulanıyor (hex doğrulamalı, injection korumalı).
- [x] **Toplu onay** — onay sayfası aynı müşterinin bekleyen postlarını listeler, tek istekte
      post başına audit kaydıyla onaylar.
- [x] **Upstash Redis rate limiting (D4)** — env değişkenleri varsa dağıtık sayaç,
      yoksa/hatada in-memory fallback.
- [x] **Vercel Blob + Resend production kurulumu (T7)** — Blob store
      `content-approval-images` canlıda, Resend `enesmemduhoglu.tech` doğrulanmış
      domain'iyle (SPF/DKIM/DMARC) gönderiyor.
