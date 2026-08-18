# TODOS

Son güncelleme: 2026-08-17 (Faz D — hatırlatma + karar geçmişi).
Canlı: https://content-approval-saas.vercel.app · **Depo artık private.**

**Açık PR yok, açık issue yok.** #21–#23, #28–#32 merge edildi; `master` = `origin/master`
ve **prod'a deploy edildi** (`content-approval-saas.vercel.app` alias'ı #32'nin
deployment'ında, canlı doğrulandı).
Prod envanteri (2026-08-17, ölçüldü): **3 ajans / 1 müşteri / 6 post** — çöp veri kalmadı.

Kod tabanı baştan sona okunup güvenlik açıkları (S1–S9) ve ürün boşlukları (F1–F13)
"Açık işler" altına işlendi. Sonra sırasıyla: **S2 + S4 kapatıldı** ve bu belge açık bir
açık listesi taşıdığı için **depo private'a alındı**; ardından **F1 + F2 + F5** (post
yönetimi) yapıldı, F13 ve S9 da onlara bindi.
Sonra **S1** (token şifreleme) ve **Faz D**'den F3 + F4 kapatıldı. **Kalanların hiçbiri
bugün sömürülebilir değil**; kalan güvenlik maddeleri (S3, S5–S8) hijyen ve derinlemesine
savunma. F11 (hata izleme) bilinçli olarak bu tura alınmadı.

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

- [x] **Doğrulama test postunu sil** — 2026-08-18'de panelden silindi. `test/bildirim-dogrulama`
      adlı `status: rejected` post, 2026-08-17 akşamı bildirim zincirini canlıda uçtan uca
      ölçmek için oluşturulmuş ve hemen reddedilmişti (red asla yayın yapmaz, Instagram'a
      hiçbir şey gitmedi). Aynı turda `karistirilan/borrow-vs-lend` de silindi: furi rutini
      18.08 08:10'da siraya koymuştu, kalitesi yetersiz bulunup reddedildi, kayıt istenmedi.
      İkisi de F2'nin "Sil" butonuyla dashboard'dan kaldırıldı — elle DB işi gerekmedi.
      *Silinen kaydın yan etkisi:* onay linki 404 döndüğü için furi'nin `esitle.py`'si
      bekleyeni çözemez ve `durum.json > bekleyen` asılı kalır; furi tarafında elle
      temizlendi ([furi#6](https://github.com/enesmemduhoglu/furi/pull/6)).
      *Prod envanteri (2026-08-18):* 7 post, hepsi `approved` + `published` — panelde
      karar bekleyen ya da reddedilmiş kayıt kalmadı.

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

- [x] **S1 — kapatıldı.** Bkz. "Tamamlananlar → token şifreleme".

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

- [x] **S9 — kapatıldı** (F2 ile birlikte: post ve müşteri artık panelden silinebiliyor).

### Ürün boşlukları (2026-08-17 inceleme turu)

Aynı turun ürün tarafı; sıralama "temel akışın deliği mi, büyüme maddesi mi" ayrımına
göre. **Temel akışın delikleri kapandı** (F1, F2, F5 + F13); kalanlar şema ya da ürün
kararı gerektiriyor.

**Temel akışın delikleri — yüksek değer, düşük maliyet**

- [x] **F1 — kapatıldı.** Bkz. "Tamamlananlar → post yönetimi".
- [x] **F2 — kapatıldı** (S9'u da kapattı). Bkz. "Tamamlananlar → post yönetimi".
- [x] **F3 — kapatıldı.** Bkz. "Tamamlananlar → Faz D".
- [x] **F4 — kapatıldı.** Bkz. "Tamamlananlar → Faz D".
- [x] **F5 — kapatıldı.** Bkz. "Tamamlananlar → post yönetimi".

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
      *2026-08-17'de bilinçli olarak ertelendi* (Faz D'de F3 + F4 yapıldı, bu alınmadı).
      Seçenekler: sıfır bağımlılıkla e-posta uyarıları (mevcut `gonder()` üzerinden) ya da
      Sentry (`@sentry/nextjs` + `SENTRY_DSN`). İlki yakalanmamış istisnaları göremez,
      ikincisi yeni bağımlılık ve dış servis getirir.
- [ ] **F12 · `/api/health` yok.** Uptime/canary izlemesi için uç nokta yok.
- [x] **F13 — kapatıldı** (F2'ye bindi: silinen postun blob'ları da siliniyor).

**Yapılırsa önerilen sıra:** Faz A (S2 → S3 → S4 → S5 → S7, hepsi küçük) · Faz B (S1 token
şifreleme, tek başına PR) · Faz C (F1 + F2 + F5, tek "post yönetimi" PR'ı) · Faz D
(F3 + F4 + F11, görünürlük turu) · sonra F6/F7/F8 ayrı ayrı tartışılır.

---

## Bilinmesi gerekenler

**Vercel'de `Sensitive` işaretli env değişkeninin DEĞERİ geri okunamaz — doğrulamayı
buna göre planla.** `vercel env ls` yalnızca adı/kapsamı gösterir; `vercel env pull` ise
sensitive değişkenler için gerçek değer yerine sabit bir yer tutucu yazar. 2026-08-17'de
kanıtlandı: `ENCRYPTION_KEY`, `AUTH_SECRET`, `CRON_SECRET`, `FURI_API_KEY` ve
`RESEND_API_KEY` — çalıştığı bilinen sırlar dahil — **hepsi birebir aynı 11 karakterlik
değeri** döndürdü. Yani "prod'daki anahtar 32 bayt mı, benimkiyle aynı mı" sorusu
CLI'dan yanıtlanamaz. Doğrulama ancak DAVRANIŞTAN yapılır (aşağıya bak).

**Düz metin token'ı şifreliye çevirirken BETİĞİ DEĞİL, production'ın kendisini kullan.**
`scripts/token-sifrele.mjs` *yerel* `ENCRYPTION_KEY` ile şifreliyor ve yukarıdaki madde
yüzünden bu anahtarın prod'unkiyle aynı olduğu **kanıtlanamıyor**. Uyuşmazlık hâlinde
betik prod'un çözemeyeceği bir kayıt yazar ve düz metin orijinali gider — **betik yedek
tutmuyor, geri dönüş yok.**
*Doğru yol:* panelden Instagram'ı bir kez YENİDEN BAĞLA. Prod token'ı kendi anahtarıyla
şifreler, uyuşmazlık riski sıfırdır; anahtar bozuksa bağlantı açık bir hatayla reddedilir
ve **mevcut token'a dokunulmaz** (başarısızlık da güvenli).
*Bu sırada tuzak:* bağlama formunda **token bitiş tarihini de gir**. Boş bırakılırsa
`instagramTokenExpiry` `null` olur ve aşağıdaki "boşsa otomatik yenileme HİÇ çalışmaz"
sorunu geri gelir.
*Doğrulama:* sonrasında `GET /api/clients/[id]/instagram-token` (Bearer `FURI_API_KEY`)
çağır. Gerçek token dönüyorsa prod anahtarı geçerli, şifreleme çalışıyor ve furi
bozulmamış — üçü tek çağrıda kanıtlanır. `500 token_undecryptable` dönerse anahtar sorunu
var demektir.
*Betik yine de duruyor:* birden fazla kaydın olduğu ya da anahtar eşliğinden emin olunan
durumlar için hâlâ doğru araç (dry-run varsayılanı, host doğrulaması, transaction içinde
geri okuma).

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

### 2026-08-17 — Faz D: hatırlatma (F3) + karar geçmişi (F4)

- [x] **F3 — bekleyen postlar artık dürtülüyor.** Yeni günlük cron
      `/api/cron/pending-reminders` (`vercel.json`, 09:00 UTC), token yenileme cron'uyla
      **aynı `CRON_SECRET`** — Vercel bütün cron'lara aynı başlığı gönderiyor, ikinci bir
      sır yönetmenin faydası yok.
      *Karar `reminders.ts`'de, saf yüklem* (`instagram-token.ts` deseni): cron yalnızca
      uyguluyor, bütün kenar durumlar tek dosyada ve testte.
      *İki ayrı olay, iki ayrı muhatap:* link HÂLÂ GEÇERLİ + post ≥2 gündür bekliyorsa
      **müşteriye** hatırlatma; link ÖLMÜŞ ama post hâlâ bekliyorsa **ajansa** bildirim —
      çünkü müşterinin elindeki link çalışmıyor, yapabilecek tek kişi ajans (F1'deki
      "Yeni link gönder"e yönlendiriyor).
      *2 gün nereden:* link 7 gün geçerli. Daha erken dürtmek rahatsızlık, daha geç
      dürtmek linkin ölmesine çok az zaman bırakır.
      *Spam koruması:* ikisi de post başına TEK SEFERLİK (`reminderSentAt`,
      `expiryNoticeSentAt`). Damga gönderimden SONRA yazılıyor; **mail gitmezse damga da
      yazılmıyor**, ertesi gün tekrar deneniyor — "bir kez fazla hatırlatma" ile "hiç
      hatırlatmama" arasında ikincisi daha pahalı.
      *Hatırlatma maili ilk mailin kopyası DEĞİL:* konusu hatırlatma olduğunu söylüyor,
      gövdesi kaç gündür beklediğini yazıyor. Aynı maili tekrar atmak "bunu zaten
      görmüştüm" refleksiyle okunmadan silinmeye yol açardı.
      Panelde "Hatırlatma gönderildi · tarih" notu var.

- [x] **F4 — `ApprovalAudit` artık okunuyor.** Panelde açılır "Karar geçmişi (N)":
      karar, zaman damgası ve IP. README'nin öne çıkardığı vaadin arayüzde ilk kez
      karşılığı var; anlaşmazlıkta ("ben onaylamadım") bakılacak yer burası.
      *Şema değişti:* `ApprovalAudit.postId` çıplak bir `String`'di — ne cascade ediyor ne
      engelliyordu, `include` de mümkün değildi. FK eklendi (`ON DELETE RESTRICT`).
      **Migration öncesi prod ölçüldü: 8 audit satırı, 0 öksüz** → FK güvenle eklendi.
      F2'nin silme sırası (audit → görsel → link → post) FK'yı zaten karşılıyor.
      *IP `"unknown"` ise gösterilmiyor:* proxy'siz ortamda başlık gelmiyor ve audit'e boş
      değer düşmesin diye sabit yazılıyor (`rate-limit.ts`); onu ekranda "unknown" diye
      göstermektense sessiz kalmak daha dürüst.
      *Etiketler rozetten farklı* ("Müşteri onayladı" / "Müşteri reddetti"): rozet ŞU ANKİ
      durumu, geçmiş satırı ise OLAN BİR OLAYI anlatıyor. Aynı kelimeyi iki anlamda iki kez
      göstermek hem okuyucuyu hem testleri şaşırttı (e2e'de "Onaylandı" iki elemana denk
      geldi ve strict mode ihlali verdi).

- [x] **F11 bilinçli olarak alınmadı** — açık madde olarak duruyor, seçenekleriyle birlikte.

- [x] **353 unit/integration + 6 e2e geçti, `tsc` temiz, build başarılı.**

**⚠ Cron sayısı:** `vercel.json` artık **iki** cron tanımlıyor (03:00 token yenileme,
09:00 hatırlatma). Vercel Hobby planında cron sayısı ve sıklığı sınırlı — deploy sonrası
Vercel → Project → Cron Jobs ekranından **ikisinin de kayıtlandığı doğrulanmalı**.

### 2026-08-17 — S1: Instagram token'ları şifrelendi

`Client.instagramAccessToken` düz metin duruyordu. Bu bir uygulama sırrı değil,
**müşterinin Instagram hesabına yayın yapma yetkisi**: bir Neon dump'ı, bir yedek ya da
Prisma query logging'in açılması doğrudan hesap ele geçirmeye çıkıyordu ve bedelini biz
değil müşteri öderdi.

- [x] **AES-256-GCM, `src/lib/crypto.ts`.** Biçim `enc:v1:<base64(iv‖tag‖ciphertext)>`.
      GCM seçildi çünkü şifrelemenin yanında **bütünlük** de doğruluyor — kurcalanmış bir
      değer sessizce yanlış token üretmiyor, çözme patlıyor.

- [x] **Geçiş kesintisiz.** `enc:v1:` öneki OLMAYAN değer düz metin kabul edilip olduğu
      gibi dönüyor, yani mevcut kayıtlar çalışmaya devam ediyor ve her yazmada şifreliye
      dönüyorlar. Testi var ("şifrelemeden önce yazılmış düz metin token çalışmaya devam
      eder").

- [x] **Anahtar yoksa ne olur — production'da FAIL CLOSED.** Yazma patlıyor; sessizce düz
      metin yazmak "şifreleme var" sanılan ama olmayan bir sistem üretirdi (bu depodaki en
      pahalı hata sınıfı tam olarak bu, bkz. #31 sessizce kaybolan mailler).
      Geliştirmede düz metne düşüp yüksek sesle uyarıyor — yerel kurulumun dış servis
      olmadan çalışması kuralı korunuyor. Panelden bağlama isteği bu durumda çıplak 500
      değil, ne yapılması gerektiğini söyleyen bir hata dönüyor.

- [x] **Çözülemeyen token sessizce geçmiyor.** Yayın `failed` oluyor ve sebebi panelde
      yazıyor; furi'nin çektiği uç nokta şifreli metni "token" diye VERMİYOR, 500 dönüyor
      (şifreli metin yanıta da sızmıyor, testi var). Paneldeki "son 4 karakter" ipucu ise
      çözülemezse yalnızca gizleniyor — kozmetik bir alan uğruna müşteri listesini komple
      düşürmek yanlış olurdu.

- [x] **Dokunulan altı nokta.** Çözme: `findInstagramCredentials` (furi'nin yolu),
      `publish-post` (yayın), cron (yenileme), `toClientView` (ipucu). Şifreleme:
      `updateInstagram` (panelden bağlama), cron (yenilenen token). Yalnızca varlık
      kontrolü yapan yerler (`isPublishTarget`, `where: { not: null }`) bilerek
      dokunulmadı — şifreli değer de doğru (truthy).

- [x] **Testler şifreleme AÇIKKEN koşuyor.** `vitest.config.ts`'e `ENCRYPTION_KEY`
      eklendi; anahtarsız koşmak tüm entegrasyon testlerinin düz metin yolundan geçmesi,
      yani **asıl kullanılan yolun hiç denenmemesi** demekti. Bu değişiklik mevcut 4 testi
      kırdı (ham kolonu düz metinle karşılaştırıyorlardı) — doğru davranışı doğrulayacak
      şekilde güncellendiler, ayrıca artık "gerçekten şifreli mi" de kontrol ediyorlar.

- [x] **`scripts/token-sifrele.mjs`** — prod'daki düz metin kalıntıyı çevirir.
      Gerekli, çünkü yazma ancak yeniden bağlama ya da cron yenilemesiyle oluyor ve
      prod'daki tek token 2026-10-15'te doluyor: cron ona ~2026-09-25'e kadar dokunmazdı,
      yani S1 prod'da gerçekte kapanmamış olurdu.
      *Emniyet:* varsayılan dry-run; zorunlu host doğrulaması (kardeş betikle aynı);
      **anahtar parmak izi** basılıyor (sha256'nın ilk 8 hanesi) ki Vercel'dekiyle
      karşılaştırılabilsin — yanlış anahtarla yazmak okunamaz kayıt üretirdi; her kayıt
      yazıldıktan sonra **transaction İÇİNDE geri okunup çözülüyor** ve orijinaliyle
      karşılaştırılıyor, tutmazsa rollback; koşullu UPDATE ile arada değişen kayda
      dokunulmuyor. Yerel DB'ye karşı dry-run → apply → ikinci koşu (idempotent) olarak
      gerçekten çalıştırılıp doğrulandı.
      *Not:* dry-run varsayılanı iş gördü — betik ilk denemede `DATABASE_URL` üzerinden
      **yerel geliştirme DB'sine** bağlandı; hiçbir şey yazılmadı.

- [x] **Betik ile uygulama biçim uyumu teste bağlandı.** Betik plain Node olduğu için
      `crypto.ts`'i içe aktaramıyor ve biçimi kopyalıyor; sessizce ayrışmasınlar diye
      `crypto.test.ts` betiğin ürettiği baytları elle kurup uygulamada çözüyor.

- [x] **323 unit/integration + 6 e2e geçti, `tsc` temiz, build başarılı.**

**⚠ DEPLOY SIRASI ÖNEMLİ:** `ENCRYPTION_KEY` Vercel Production'a **merge'den ÖNCE**
eklenmeli. Eklenmezse mevcut düz metin token'lar okunmaya devam eder (yayın çalışır) ama
**panelden yeni Instagram bağlanamaz** ve **cron token yenileyemez** (o müşteri `failed`
sayılır). Üret: `openssl rand -base64 32`.
*Durum (2026-08-17):* eklendi — `content-approval-saas` projesinde, kapsam
**Preview + Production**, Sensitive. (İlk denemede yanlış projeye — `web-projesi` —
eklenmişti; oradan silinmeli.) Prod'daki tek düz metin kayıt: `Furkan Teacher`
(`7b76443b401b4f56bc7686b1a70835ba`), 186 karakter.

### 2026-08-17 — post yönetimi (F1 + F2 + F5)

Güvenlik tarafında sömürülebilir bir şey kalmayınca sıra günlük kullanımda en çok
hissedilen boşluklara geldi. Üçü tek PR: oluştur → takip et → düzelt/yenile → sil.

- [x] **F1 — onay linki yenilenebiliyor.** `POST /api/posts/[id]/approval-link`.
      Link 7 günde ölüyordu ve yenilemenin YOLU YOKTU: müşteri tatildeyse post kalıcı
      kilitleniyordu. Süresi dolmuş link `renew` istenmese bile yenilenir (süresi geçmiş
      bir linki tekrar e-postalamak kullanıcıyı boşuna yürütür); `renew: true` geçerli
      linki de değiştirir — sızan link için iptal yolu. **Eski token anında ölür**
      (e2e ile doğrulandı). Karar verilmiş postta link yenilenir ama mail GİTMEZ:
      "İncele ve Onayla" maili yanlış bilgi olurdu. Yenileme orada da gerekli, çünkü
      onay sayfasındaki "Instagram'a yayınla / tekrar dene" butonu o linkten çalışıyor.

- [x] **F2 — post ve müşteri silinebiliyor, caption düzeltilebiliyor.**
      `PATCH`/`DELETE /api/posts/[id]`, `DELETE /api/clients/[id]`.
      *Sınırlar bilinçli:* yayınlanmış post **silinmez** (kaydı silmek "bu yayınlandı mı"
      sorusunu cevapsız bırakır ve mükerrer yayın korumasının baktığı kardeş kaydı yok
      eder — aynı kural temizlik betiğinde de var); caption yalnızca `pending` iken
      değişir (karar verilmiş postun metnini değiştirmek onay kaydını sessizce yalan
      yapardı); postu olan müşteri silinmez, kaç postu olduğu söylenir.
      *`ApprovalAudit`'in Post'a FK'sı YOK* — cascade etmez, engellemez; elle silinmezse
      öksüz satır kalırdı. Silme transaction'ı audit + görsel + link + post sırasıyla
      temizliyor, testi de var.
      *F13 buraya bindi:* silinen postun Blob dosyaları da siliniyor (best-effort, asla
      throw etmez — post gerçekten silindi, dosya kaldıysa "silinemedi" demek yanıltıcı
      olurdu). `raw.githubusercontent.com`'daki makine-API görselleri **bizim değil**,
      `isOwnBlobUrl` ile ayıklanıyor.
      *Kapsam dışı:* görsel değiştirme (yeni yükleme + eski blob + sıra yönetimi demek);
      görsel yanlışsa post silinip yeniden oluşturulur.

- [x] **F5 — mail durumu panelde.** Yeni alanlar `Post.approvalEmailSent` /
      `approvalEmailError` / `approvalEmailSentAt` (migration: üç nullable kolon).
      #31 bu bilgiyi yalnızca **API yanıtına** koymuştu: yanıtı gören otomasyon
      öğreniyor, panele bakan insan asla öğrenemiyordu. Artık rozet var ve
      **başarıyı da gösteriyor** — sessiz kalsaydı "gitti" ile "hiç denenmedi" yine
      ayırt edilemezdi, yani sorun çözülmemiş olurdu. `null` (eski postlar) bilerek
      sessiz: onlar için gerçekten bilmiyoruz. Mailin neden gitmediği de satırda yazıyor.

- [x] **PR #34'ün CSP'si yerel `npm run dev`'i bozuyormuş — düzeltildi.**
      Next.js'in dev sunucusu HMR ve source map'ler için `eval()` kullanıyor;
      `script-src`'de `'unsafe-eval'` olmadığı için istemci JS'i hiç çalışmıyordu:
      sayfa sunucudan render olmuş **görünüyor** ama hidrasyon sessizce ölüyor,
      butonlar tıklanıyor ve hiçbir şey olmuyordu. E2E'nin üçü tam bu yüzden düştü.
      **Production etkilenmemişti** (production build `eval` kullanmaz, canlıda
      doğrulanmıştı) — yalnızca yerel geliştirme. İzin artık yalnızca dev'de veriliyor.
      *Ders:* CSP değişikliğini yalnızca production build'de doğrulamak yetmiyor;
      `npm run test:e2e` (dev sunucusu) ayrı bir ortam ve ayrı davranıyor.

- [x] **297 unit/integration + 6 e2e testi geçti, `tsc` temiz, build başarılı.**
      Yeni e2e'ler: "link yenileme → eski token ölür, yeni token çalışır" ve
      "post silme → onay linki de ölür".

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
