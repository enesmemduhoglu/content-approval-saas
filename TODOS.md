# TODOS

Son güncelleme: 2026-08-26 (onay endpoint'i `publishedAt` dönüyor — furi'nin
yayın defteri gerçek yayın saatini okuyabilsin diye).
Canlı: https://content-approval-saas.vercel.app · **Depo PUBLIC** — bulgu
yazarken "Depo görünürlüğü" bölümündeki kurallar geçerli.

**#40–#44 merge edildi ve prod'a deploy edildi** (2026-08-22):

| Sıra | PR | Ne | Test |
|---|---|---|---|
| 1 | #40 | S3, S5, S6, S7, S8 + F11, F12 | 385 |
| 2 | #41 | F7 kota tavanları | 395 |
| 3 | #42 | F8 zamanlanmış yayın | 417 |
| 4 | #43 | F6 ekip üyeleri | 476 |
| 5 | #44 | F10 revizyon turu | 527 |

Her PR bir öncekini baz alıyor; sıra bozulursa diff'ler karışır. Hepsi
`master`'dan sonra gelen iki commit'le (`next.config.ts` CSP düzeltmesi,
PR #39) çakışmıyor — o dosyaya hiçbiri dokunmuyor.

Prod envanteri (2026-08-22, ölçüldü): **2 ajans / 1 müşteri / 13 post.**
22 Temmuz'dan kalma iki boş test ajansı `bos-ajans-temizligi.mjs --apply` ile
silindi (tek transaction, atlanan yok).

**S1–S9 ve F1–F13'ün tamamı kapandı.** Bu turda kapananlar: S3, S5, S6, S7, S8
(güvenlik hijyeni — hiçbiri sömürülebilir değildi, derinlemesine savunma),
F7 (kota), F8 (zamanlanmış yayın), F6 (ekip üyeleri), F10 (revizyon turu),
F11 (hata izleme), F12 (`/api/health`).

Kalan açık maddeler üç kümede: **merge sonrası elle yapılacak işler**, **bilinçli
kapsam dışı**, ve 2026-08-23 kod denetiminden çıkan **D1–D9**. D serisi ilk
ikisinden farklı — bunlar bilinçli bırakılmış boşluklar değil, kimsenin farkına
varmadığı eksikler; hiçbiri canlıda bir arıza olarak yaşanmadı, hepsi kaynak
taramasından çıktı. **D1 faz J ile kapandı** (CI); kalan öncelik sırası
**D3 (mail tavanları) → D2 (`checkOrigin` kapsamı)**.

---

## Depo görünürlüğü (2026-08-23) — private kararı geri alındı

**Depo şu an PUBLIC** (`gh repo view` ile doğrulandı: 0 fork / 0 star). Bu,
2026-08-17'de bilerek alınan "private'a çek" kararının geri alınması demek.
O karar ve gerekçesi "Tamamlananlar → 2026-08-17 güvenlik turu"nda tarihsel
kayıt olarak duruyor; silinmedi, çünkü neden alındığını bilmeden neden geri
alınabildiği de anlaşılmaz.

**O gün private'a çekilme gerekçesi bugün geçerli değil.** Gerekçe "açıklar
AÇIKTI ve tarifi yazılıydı"ydı — sömürülebilir olan S2 (production'da test
girişi) ve S4 (clickjacking) aynı turda, S3/S5–S8 #40'ta kapandı. Bugün açık
duran tek seri D2–D9 ve hiçbiri kimliği doğrulanmamış bir saldırgana bir şey
vermiyor; en yakını D3 — o da **oturum açmış ajans kullanıcısının kendi
müşterisine** sınırsız mail attırabilmesi.

**Ama bu dosya artık herkes tarafından okunuyor.** Yeni bulgu yazarken kural:

- **Sömürülebilir bir açık bulunursa önce kapatılır, sonra yazılır.** Açık
  dururken tarifini buraya yazma. Sonradan private'a çekmek sızıntıyı geri
  ALMAZ: PR'ın diff'i ve gövdesi GitHub'da kalır, force-push sonrası kopuk
  commit'ler SHA ile erişilebilir kalır — 17.08'de tam olarak bu hesaplandı.
- **Sır DEĞERİ hiçbir koşulda yazılmaz**, yalnızca adı (`CRON_SECRET`,
  `FURI_API_KEY`, Resend/Blob token'ları bu dosyada bugüne kadar hep böyle geçti).
- Prod id'leri ve iki e-posta adresi bu dosyada zaten var ve 22 Temmuz'dan beri
  oradaydı; yenisini eklemenin bir faydası yok.

**Görünürlük değişince ilk bakılacak yer burasıdır** — dosyanın en üstündeki
"Depo public/private" satırı ile bu bölüm birlikte güncellenir.

---

## Davet devri (2026-08-23) — F6'nın canlıda yakalanan boşluğu

**Belirti:** `enesmemduhoglu0@gmail.com` ajansından `eneshan034@gmail.com`'a
davet gönderildi, mail geldi, `/invite/<token>` sayfası doğru göründü — ama o
hesapla giriş yapınca **hiçbir şey olmadı**.

**Sebep:** `resolveMembershipOnSignIn` girişte önce "bu `googleId`nin üyeliği
var mı" diye bakıyor ve **varsa oracıkta dönüyor**; bekleyen davete hiç
bakmıyor. `eneshan034`'ün zaten bir üyeliği vardı: 2026-08-18'de kendisine
açılan boş ajans, F6 migration'ının backfill'iyle bir `AgencyMember` satırına
dönüşmüştü. Yani davet edilen kişi kendi boş ajansının dashboard'una düşüyor,
davet `acceptedAt: null` olarak sonsuza kadar duruyordu. Davetin OLUŞMASI
engellenmemişti çünkü `scoped-db.ts > invites.create`'teki `already_member`
kontrolü yalnızca **aynı ajanstaki** üyeliğe bakıyor.

**Kök kısıt:** `AgencyMember.googleId` `@unique` — bir Google hesabı tam olarak
bir ajansa ait. Bu kısıt `session.agencyId`in düz bir string kalmasını sağlayan
şeyin ta kendisi, yani "zaten üye olan biri daveti kabul edemez" bir hata değil,
şemadan çıkan bir sonuçtu.

**Seçilen çözüm: DEVİR.** Üç seçenek tartışıldı:

| Seçenek | Neden seçilmedi / seçildi |
|---|---|
| Çok-ajanslı üyelik + ajans değiştirici | Doğru uzun vadeli cevap ama `googleId` unique'in kalkması, aktif ajans seçimi ve `session.agencyId` sözleşmesinin (78 çağrı yeri) yeniden düşünülmesi demek. Ayrı bir faz. |
| Yalnızca engelle (davet oluşturmada hata ver) | Sorunu görünür kılar ama çözmez; davet alan mevcut kullanıcı akışı hiç çalışmamaya devam ederdi. |
| **Devir (seçildi)** | Şemaya dokunmadan daveti çalıştırıyor. Üyelik satırı siliniyor, hedefte yenisi açılıyor; unique kısıt ve `getScopedDb` sözleşmesi aynen duruyor. |

**Devrin kuralları:**

- **Giriş SESSİZCE devretmez.** `resolveMembershipOnSignIn` aynen eski
  davranışta bırakıldı (test: "zaten bir ajansın üyesiyse davet dikkate
  alınmaz"). Devir ayrı ve açık bir eylem: `/invite/<token>` sayfasındaki
  onay düğmesi → `POST /api/invites/<token>/accept`. Girişin kullanıcıyı
  onayı olmadan kendi ajansından düşürmesi kabul edilemezdi.
- **Kabul yine E-POSTA ile.** Token sadece "hangi davet" sorusunu cevaplıyor;
  kabul koşulu giriş yapılmış hesabın e-postasının davetinkiyle eşleşmesi.
  Linki ele geçiren yabancı devri tetikleyemez.
- **Dolu ajansın son owner'ı devredemez** (`last_owner_with_data`, 409).
  Ayrılsa müşteri ve postlar sahipsiz kalır — kimse davet edemez, kimse üye
  çıkaramaz. `members.removeById`deki `last_owner` korumasının aynısı, ama
  **boş** ajans için gevşetilmiş: kaybedilecek bir şey yoksa tutmanın anlamı yok.
  Sayfa bu durumu düğmeye bastırmadan önce söylüyor (`blocked`).
- **Yarış koruması koşullu UPDATE ile**, depo kuralına uygun: davet önce
  `updateMany({ acceptedAt: null, expiresAt: { gt: now } })` ile "kapılıyor",
  `count === 0` ise devir hiç yapılmıyor.
- **`getScopedDb` bilerek kullanılmadı** (route'taki tek istisna, gerekçesi
  dosyanın başında): kapsam oturumdaki ajansa göre — oysa işin tamamı
  kullanıcıyı o ajanstan ÇIKARMAK. Yerine geçen koruma daha dar: hedef ajans
  istekten değil davet token'ından geliyor.
- **Oturum anında tazeleniyor.** Devirden sonra `unstable_update({})` jwt
  callback'ini `trigger: "update"` ile çalıştırıp çerezi yeniden yazıyor;
  olmasaydı kullanıcı 5 dakikaya kadar (`MEMBERSHIP_REVALIDATE_MS`) terk
  ettiği ajansın panelinde kalırdı. Tazeleme patlarsa devir **geri alınmıyor**
  — yanıttaki `sessionRefreshed: false` arayüze "birkaç dakika içinde
  yenilenecek" dedirtiyor.
- **Terk edilen boş ajans OTOMATİK SİLİNMİYOR.** Ajans silmek bu depoda ayrı
  ve bilinçli bir karar (bkz. `bos-ajans-temizligi.mjs` emniyet zinciri).
  Route yalnızca log'a "temizlik adayı" yazıyor.

Yan düzeltme: `/invite` sayfasındaki giriş linkinde `callbackUrl` yoktu,
kullanıcı girişten sonra `/`'a düşüyordu. Artık davet sayfasına geri dönüyor —
devir gerektiren durumda onay düğmesini bir daha hiç görmemesinin sebebi buydu.

Test: 527 → 567. **#47 ile merge edildi ve prod'da doğrulandı** (2026-08-23):
`eneshan034` devirle asıl ajansa geçti, arta kalan boş ajans silindi.

---

## Ajans bildirimleri ekibe (2026-08-23) — F6'nın ikinci canlı boşluğu

**Belirti:** `enesmemduhoglu0@gmail.com` hesabının "furkan teacher" müşterisine
onay maili gitti, müşteri onayladı, post Instagram'a çıktı — ajanstaki **iki
kullanıcının da (`enesmemduhoglu0@`, `eneshan034@`) hiçbir şeyden haberi olmadı**.
Ne "onaya gitti" ne "onaylandı" bildirimi ulaştı.

**Sebep:** Bütün ajans bildirimleri `Agency.email`e gidiyordu. O kolon ajans
KURULURKEN, kuran Google hesabından bir kez yazılıyor ve bir daha hiç
güncellenmiyor (`membership.ts > resolveMembershipOnSignIn`). F6 ekip üyeliğini
getirdiğinden beri o adres "ajansı kim kullanıyor" sorusunun cevabı değil,
"ajansı kim açmıştı" sorusunun cevabı:

- **Davetle katılan üye hiç bildirim almıyordu.** Ekip özelliği vardı, bildirimler
  F6 öncesindeki tek kullanıcılı dünyada kalmıştı.
- **Kurucu adresi eskiyse bildirim kimsenin bakmadığı kutuya düşüyordu** — ajans
  başka bir hesapla açılmışsa, kurucu ekipten çıkmışsa ya da ajans davet devriyle
  el değiştirmişse. `gonder()` "gitti" dediği için hata da görünmüyordu.

**Çözüm:** `src/lib/agency-notify.ts` — alıcı listesi artık `AgencyMember`
satırlarından üretiliyor, `Agency.email` listeye ekleniyor ama tek kaynak değil.
Tekilleştirme küçük harf üzerinden (ajansı açan kişi zaten kendi ajansının ilk
üyesi; normalize etmeden aynı kişiye iki kez yazardık). Owner'lar listenin
başında — `To`da ilk görünen işin sahibi olsun.

**Neden tek mail, üye başına ayrı mail değil:** Resend tek istekte çoklu alıcıyı
destekliyor. Üye başına ayrı istek günlük kotayı üye sayısına bölerdi ve cron'un
süre bütçesini üyeyle çarpardı. Alıcılar birbirini görüyor — hepsi aynı ajansın
ekibi, panelde zaten birbirlerinin adresini görüyorlar.

**Kapsanan yollar (dördü de):** post oluşturma (`request_sent`), onay sayfası
(`approved` / `rejected` / `revision_requested`), `publish-scheduled` cron'u
(zamanlanmış yayının akıbeti), `pending-reminders` cron'u (`link_expired`).
`Agency.email` şemada duruyor ve silinmedi: bilinen tek adres olduğu durumlarda
(üye sorgusu patlarsa) hâlâ düşülecek yer o.

Bildirim yine bir **yan etki**: `notifyAgencyTeam` asla throw etmez, alıcı
bulunamazsa `sent: false` döner ve sebebi log'a yazar — onay da, yayın da,
cron da buna bağlı değil.

Test: 567 → 578.

---

## Açık işler

### Elle yapılması gerekenler (repo yapamaz)

- [x] **`ALERT_EMAIL` Vercel prod env'ine eklendi** (2026-08-22).
      Değer: `eneshan034@gmail.com` — bilerek ajans bildirimlerinden
      (`enesmemduhoglu0@gmail.com`) AYRI bir kutu: buraya "hattın kendisi bozuk"
      sinyali gider, tek bir postun akıbeti değil.
      **Non-sensitive olarak eklendi**, çünkü CLI varsayılanı Sensitive'di ve
      deponun kayıtlı tuzağı gereği sensitive değişkenin değeri bir daha geri
      okunamıyor — bir e-posta adresi için bu gereksiz bir körlük. Değer
      `vercel env pull` ile geri okunarak doğrulandı.
      *Env yalnızca yeni deploy'da okunur:* alias'ın bulunduğu prod deployment'ı
      aynı commit'le yeniden deploy edildi (`vercel redeploy`), alias yeni
      deployment'a taşındı ve `/api/health` 200 `{"status":"ok"}` döndü.
      **Doğrulanmayan tek şey:** gerçek bir uyarı e-postasının teslim edildiği
      görülmedi — bunun için kasten bir hata üretmek gerekirdi. Değişken yerinde
      ve canlı; ilk gerçek cron/yayın hatasında teslim gözlenmeli.

- [x] **İkinci Google hesabı asıl ajansa katıldı** (2026-08-23, #47 merge edildikten
      sonra ölçüldü). `eneshan034@gmail.com` artık
      `cmsw2ajnq0000jm04d6m9puei` ajansında `member` rolünde (katılım
      07:31), davet aynı damgayla `acceptedAt` aldı. Devir tek üyelik satırı
      bıraktı — eski ajansta 0 üye kaldı, yani `googleId @unique` sözleşmesi
      bozulmadı. F6 öncesinden kalan "bir Google hesabı = bir ajans" sorunu
      bu hesap için tamamen kapandı.

- [x] **Devirden arta kalan boş ajans silindi** (2026-08-23).
      `Enes Memduhoğlu <eneshan034@gmail.com>` / `cmsz2d51f0001jm04zru0r725`,
      `bos-ajans-temizligi.mjs --apply` ile, tek transaction, atlanan yok.
      *Betiğin kendisi de güncellendi ve bunu yaparken 7. emniyet kuralı
      gerçekten iş gördü:* F6'nın eklediği `AgencyMember` / `AgencyInvite`
      FK'leri `BILINEN_FK_TABLOLARI`nda olmadığı için betik tek satır silmeden
      durdu. Güncellemede üç şey değişti — (a) o iki tablo listeye eklendi,
      (b) "boş" tanımına **üye sayısı** girdi (içi boş ama üyesi olan ajans
      birinin bugün giriş yaptığı ajanstır; silinirse o kişi hiçbir yere
      giremez, çünkü auth `agencyId`yi üyelikten çözüyor), (c) kalan davetler
      Agency'den ÖNCE siliniyor — FK `RESTRICT`.

**Prod envanteri (2026-08-23, ölçüldü): 1 ajans / 2 üye / 1 müşteri / 13 post.**

- [x] **Branch protection açıldı** (2026-08-23, ruleset `master korumasi`,
      id `21237624`). CI artık tavsiye değil kapı. API'den doğrulanan hâli
      (`/rules/branches/master`):
      `enforcement: active` · hedef **default branch** (ad değişse de takip eder) ·
      `pull_request` (gerekli onay **0** — tek kişilik depoda 1 yazmak kendi
      PR'ını onaylayamayıp kilitlenmek demekti) · `required_status_checks`:
      **`dogrula`**, kaynak GitHub Actions'a sabitlenmiş (`integration_id 15368`)
      ki aynı adı raporlayan başka bir uygulama kuralı geçemesin ·
      `strict_required_status_checks_policy: true` (PR merge'den önce master'la
      güncel olmalı — "iki PR ayrı ayrı yeşil, birlikte kırık" senaryosunu bu
      yakalıyor) · `deletion` + `non_fast_forward`.
      **Bypass listesi bilerek BOŞ.** Repo admin'ini muaf tutmak kuralı hiç
      kurmamakla aynı şey olurdu; deponun tek geliştiricisi olan kişinin de
      kapıdan geçmesi gerekiyor. Acil durumda çıkış yolu ruleset'i geçici olarak
      `Disabled` yapmak — iz bırakır, bypass bırakmaz.
      *Kurulum sırasında öğrenilen:* check listesine eklenecek ad workflow'un adı
      (`CI`) DEĞİL **job'ın adı** (`dogrula`), ve o ad ancak bir kez koştuktan
      sonra arama sonuçlarında çıkıyor.

- [ ] **Vercel planını gözden geçir — F8 bu yüzden yarım çalışıyor.**
      Hobby planı cron'ları **günde bire** sınırlıyor ve o tek koşu dakika
      hassasiyetinde değil (tanımlı saat içinde herhangi bir an, ±59dk). Yani
      `publishAt` şu an "en iyi saatte yayınla" DEĞİL, **±24 saat isabet**.
      Kod tarafında yapılacak bir şey yok: Pro'ya geçilince `vercel.json`'daki
      tek satır saatlik desene çevrilir ve özellik tam çözünürlüğe kavuşur.

### Denetim bulguları (2026-08-23) — D1–D9

Kod okunarak yapılan tur. **Hiçbiri canlıda bir arıza olarak yaşanmadı**, hepsi
kaynak taramasından çıktı; bu yüzden S/F serisine değil ayrı bir seriye yazıldı.
Tur sırasında ölçülenler: `npx tsc --noEmit` temiz, `npm test` 45 dosya / 578
test yeşil. Yani bulguların hiçbiri "bozuk kod" değil — **eksik kod**.

- [x] **D1 · CI — KAPATILDI (faz J).** `.github/workflows/ci.yml`: PR'da ve
      master'a push'ta `tsc` → `migrate deploy` → şema kayması → `npm test` →
      `npm run build`. Ayrıntı "Tamamlananlar → faz J"de.
      **Kalan elle iş kalmadı:** branch protection da aynı gün açıldı (ruleset
      `master korumasi`, bkz. "Elle yapılması gerekenler") — CI artık tavsiye değil kapı.

- [ ] **D2 · `checkOrigin` değişmezi 6 mutasyon handler'ında uygulanmamış.**
      CLAUDE.md "mutasyon route'larında `checkOrigin`" diyor ve depoda
      `middleware.ts` YOK — yani kuralı uygulayacak tek yer route'un kendisi.
      Eksik olanlar: `clients/route.ts` POST, `clients/[id]/route.ts` DELETE,
      `clients/[id]/instagram/route.ts` POST + DELETE,
      `posts/[id]/approval-link/route.ts` POST, `posts/[id]/resubmit/route.ts` POST.
      *Sömürülebilir DEĞİL:* altısı da ya `request.json()` okuyor ya DELETE, ikisi
      de "basit istek" sınıfına girmediği için preflight tetikliyor; oturum çerezi
      de `SameSite=Lax`. Gerçekten riskli olan multipart yolları (`/api/posts`,
      `/api/agency`) zaten korumalı.
      *Yine de kapatılmalı,* çünkü `origin.ts`'in var olma gerekçesi tam olarak
      "tek bir çerez ayarına yaslanma"ydı. Kuralın kapsamı delikliyse kural
      okunduğu gibi çalışmıyor demektir; asıl bedel bugünkü açık değil, "bu
      route'ta niye yok" sorusunun bir dahaki sefere kimsenin aklına gelmemesi.

- [ ] **D3 · Mail gönderen iki panel yolunda hiçbir tavan yok.**
      `POST /api/posts/[id]/approval-link` (link yenile → müşteriye onay maili
      YENİDEN gider) ve `POST /api/posts/[id]/resubmit` (→ revize post maili) ne
      `checkRateLimit` ne kota görüyor. Aynı postta düğmeye basmak müşterinin
      kutusuna sınırsız mail atar; bedeli Resend kotası ve gönderen alan adının
      itibarı — ikisi de TÜM ajansları etkileyen ortak kaynak, F7'nin korumaya
      çalıştığı şeyin ta kendisi.
      *`quota.ts`'teki yorum bu yüzden artık yanlış:* "davet butonu, keyfi bir
      adrese ajansın markasıyla mail attırabilen tek yüzey" yazıyor. Doğrusu:
      davet KEYFİ adrese gidebilen tek yüzey, ama sınırsız mail attırabilen tek
      yüzey değil. Düzeltme yapılırken o yorum da güncellenmeli.

- [ ] **D4 · Cron'lar için ölü adam anahtarı yok.** `sendAlert` yalnızca cron
      **koşup hata verdiğinde** çalışıyor (üç cron + `publish-post.ts`). Cron hiç
      tetiklenmezse — zamanlama silinmiş, plan düşmüş, deployment bozuk — hiçbir
      yerden ses çıkmaz: `scheduled` postlar sonsuza kadar bekler, token
      yenileme sessizce durur, ilk haber müşteriden gelir.
      *En ucuz şekli:* her cron son başarılı koşusunun zamanını bir yere yazsın,
      `/api/health` bunu raporlasın. Dikkat — `/api/health` public ve yanıtı
      F12'de BİLEREK sığ tutuldu (sürüm/sayı/env yok); "son koşu 3 gün önce"
      bilgisi de bir iç durum sızıntısıdır, sığ yanıtı bozmadan çözülmeli.

- [ ] **D5 · Hata/404 sınırı yok — müşteriye Next'in İngilizce ekranı çıkıyor.**
      `src/app/` altında ne `error.tsx`, ne `not-found.tsx`, ne `global-error.tsx`
      var. Panelde bu bir kozmetik eksik; asıl mesele `/approve/[token]`: giriş
      gerektirmeyen, ajansın MÜŞTERİSİNE gösterilen sayfa. Orada bir render
      hatası, ajansın markasıyla açılmış bir sayfada standart İngilizce Next
      hata ekranı demek.

- [ ] **D6 · `noindex` yok.** `/approve/[token]` ve `/invite/[token]` token'ı
      URL'in kendisinde taşıyor; `layout.tsx`'te `robots` metadata'sı ve
      `public/robots.txt` yok. `Referrer-Policy` (next.config.ts) token'ın dış
      host'a `Referer` ile sızmasını kapatıyor ama İNDEKSLENMESİNİ değil — link
      bir kez herkese açık bir yere düşerse arama motoru onu tarayabilir.

- [ ] **D7 · `.env.example`'da `KV_REST_API_URL` / `KV_REST_API_TOKEN` eksik.**
      `rate-limit.ts` ikisini de okuyor (Vercel Marketplace'in Upstash
      entegrasyonu bu adları kuruyor, doğrudan Upstash kurulumu
      `UPSTASH_REDIS_REST_*` veriyor) ama kurulum belgesi yalnızca ikinci çifti
      sayıyor. Sonucu sessiz: değişkenler yoksa `checkRateLimit` patlamaz,
      in-memory fallback'e düşer — yani rate limit "çalışıyor" görünürken
      serverless instance'lar arasında paylaşılmaz.

- [ ] **D8 · Test boşlukları.** `src/lib/scoped-db.ts` (821 satır, IDOR
      korumasının TAMAMI) ve `src/lib/quota.ts` için ayrı birim testi yok —
      ikisi de yalnızca route testlerinden dolaylı kapsanıyor. `settings/page.tsx`
      ve `team-panel.tsx` (256 satır) diğer sayfaların aksine `.ui.test.tsx`'siz.
      e2e tarafında `approval-flow.spec.ts`'teki 6 senaryo onay/red/link/silmeyi
      görüyor; **F6 (ekip daveti), F8 (zamanlanmış yayın) ve F10 (revizyon turu)
      uçtan uca hiç koşulmuyor** — üçü de bu turun en yeni ve en az yıpranmış
      kodu.

- [ ] **D9 · Toplu onay `publishStatus`'a dokunmuyor.** Tekil yol
      `publishApprovedPost` üzerinden `skipped` yazarken `/batch` postu `idle`
      bırakıyor; iki yol aynı sonuca farklı satır yazıyor.
      *Bugün görünür bir hata DEĞİL:* `PublishBadge` `idle`'ı yalnızca
      `awaitingPublish` (= müşteride Instagram bağlı) ile gösteriyor, batch ise
      zaten yalnızca Instagram'ı OLMAYAN postları onaylıyor — yani rozet çıkmıyor.
      Kayıt tutarsızlığı olarak duruyor; batch'in kapsamı bir gün genişlerse
      (bkz. "Bilinçli kapsam dışı → toplu onayda ajans bildirimi") sessiz bir
      yanlış rozete dönüşür.

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

- [ ] **Toplu onayda (`/batch`) ajans bildirimi yok** — #32 tekil yolu kapsıyor,
      batch'i bilerek kapsamadı: o yol zaten yayın yapmıyor ve her post için ayrı
      mail istenmez. Batch yeniden ele alınırsa tek bir özet bildirim mantıklı.
      **2026-08-23 notu:** bildirimlerin ekibe açılması bu boşluğu KAPATMADI —
      toplu onayda hâlâ kimseye mail gitmiyor. Artık tek doğru şekli belli:
      `notifyAgencyTeam` ile N postu tek satırda özetleyen bir bildirim.
      *Ele alınırsa D9 da aynı turda kapatılmalı* — batch'in `publishStatus`'a
      hiç dokunmaması bugün zararsız, ama kapsam genişlerse yanlış rozete döner.

- [ ] **Toplu reddetme** — reddetme sebebi post başına anlamlı olduğu için toplu
      onayın simetriği yapılmadı. Yeniden değerlendirilirse "ortak sebep" alanı gerekir.

- [ ] **F9 · Yalnızca Instagram, yalnızca görsel.** Reels/video yok
      (`ALLOWED_IMAGE_TYPES` üç format), başka platform yok. Bilinçli kapsam;
      yol haritasında adı geçsin diye burada duruyor.

- [ ] **Zamanlanmış yayın `failed` olursa otomatik tekrar denenmiyor** (F8, #42).
      Cron yalnızca `scheduled` tarıyor. Sessiz DEĞİL — F11 uyarısı ve ajans
      bildirimi gidiyor — ama tekrar deneme müşterinin onay sayfasından manuel.
      Otomatik tekrar deneme bilerek eklenmedi: çift yayın riski taşır ve ayrı
      bir tasarım kararı hak ediyor.

- [ ] **Revizyon bekleyen posta hatırlatma yok** (F10, #44). `reminders.ts` ve
      cron yalnızca `pending` tarıyor; top ajanstayken kimse dürtülmüyor.
      F3'ün simetriği, ayrı bir iş.

- [ ] **Görsel revizyonu yalnızca JSON `imageUrls` yolundan** (F10, #44).
      Panelden dosya yükleyerek görsel değiştirme yok — mevcut
      `PATCH /api/posts/[id]` de bunu bilinçli kapsam dışı bırakmıştı, aynı
      sınır korundu. Yani akış API'da var, UI'da yok.

- [ ] **Revizyon turunda onay linki AYNI token'la devam ediyor** (F10, #44).
      Müşterinin elindeki maildeki link ölmesin diye; yalnızca süre tazeleniyor.
      Bedeli: çok turlu bir postta link fiilen aylarca yaşayabilir. Sızmış link
      senaryosunda ajansın ayrıca `renew: true` demesi gerekiyor — o yol duruyor.
      *Bu, F10'un en az emin olunan kararı; yeniden ele alınabilir.*

### Güvenlik (S1–S9 — HEPSİ KAPANDI)

Kod okunarak yapılan 2026-08-17 turu. Sömürülebilir olan ikisi (S2, S4) o gün
kapatıldı; S1 (token şifreleme) ayrı turda; kalanlar (S3, S5–S8) 2026-08-22'de
**#40** ile kapandı. Kalanların hiçbiri sömürülebilir bir açık DEĞİLDİ — hijyen
ve derinlemesine savunmaydı. Temiz çıkan alanların listesi "Bilinmesi
gerekenler"de; yeniden taranmasın.

- [x] **S1 — kapatıldı.** Bkz. "Tamamlananlar → token şifreleme".
- [x] **S2 — kapatıldı.** Bkz. "Tamamlananlar → 2026-08-17 güvenlik turu".
- [x] **S3 — kapatıldı (#40).** `npm audit --omit=dev` **8 high → 3 high**.
      `@vercel/blob` 2.8.0 (undici zinciri), `nanoid`, ve `deepmerge-ts`
      (`@prisma/config` sabit pinlediği için `overrides` ile zorlandı).
      *Kalan 3 high BİLİNÇLİ:* hepsi `next` → `postcss`/`sharp` zincirinde ve
      düzeltmesi Next 16'ya semver-major sıçrama. Proje `next/image`
      kullanmıyor, `sharp` istek yoluna hiç girmiyor; `postcss` build zamanı.
      Next 16 kendi başına planlanmalı — güvenlik gerekçesiyle aceleye gelmez.
- [x] **S4 — kapatıldı.** Bkz. "Tamamlananlar → 2026-08-17 güvenlik turu".
- [x] **S5 — kapatıldı (#40).** Token uç noktasına rate limit (mevcut
      `checkRateLimit` yeniden kullanıldı, kontrol auth'tan ÖNCE) ve sır
      taşımayan erişim kaydı (`clientId` + zaman + sonuç) eklendi.
- [x] **S6 — kapatıldı (#40).** Magic-byte kontrolü: ilk baytlardan gerçek tip
      tespit ediliyor, beyanla uyuşmayan dosya reddediliyor, uzantı gerçek
      tipten türetiliyor. *Kazanç güvenlikten çok teşhis:* sahte MIME'lı dosya
      artık yayın anında değil yükleme anında patlıyor.
- [x] **S7 — kapatıldı (#40).** `x-vercel-forwarded-for` önceliği.
- [x] **S8 — kapatıldı (#40).** `Origin` kontrolü ikinci katman olarak eklendi.
      İzin verilen origin isteğin kendi host'undan türetiliyor (preview
      dağıtımları env listesi gerektirmeden çalışsın diye); API anahtarlı
      makine yolu muaf.
- [x] **S9 — kapatıldı** (F2 ile: post ve müşteri panelden silinebiliyor).

### Ürün boşlukları (F1–F13 — HEPSİ KAPANDI)

- [x] **F1, F2, F5, F13** — post yönetimi turu. Bkz. "Tamamlananlar".
- [x] **F3, F4** — Faz D (hatırlatma + karar geçmişi).
- [x] **F6 — kapatıldı (#43).** `AgencyMember` + davet akışı.
      `session.agencyId` sözleşmesi BİLEREK korundu: 78 çağrı yerini dolaylamak
      yerine üyelik çözümü tek yerde, auth katmanında yapılıyor.
      *JWT bayatlığı çözüldü:* üyelik 5 dakikada bir DB'den yeniden doğrulanıyor
      (yoksa çıkarılan üye token ömrü boyunca — 30 gün — erişmeye devam ederdi).
      **Kalan sınır:** erişim anında kesilmiyor, en fazla 5 dk sürebilir; acil
      durumda kesin çözüm `AUTH_SECRET` döndürmek.
      *2026-08-23 eki:* "zaten bir ajansın üyesi olan biri daveti kabul
      edemiyor" boşluğu canlıda yakalandı ve **devir**le kapatıldı — bkz.
      yukarıdaki "Davet devri" bölümü. Çok-ajanslı üyelik hâlâ kapsam dışı.
- [x] **F7 — kapatıldı (#41).** Kaba kötüye kullanım tavanları; plan/faturalama
      sistemi DEĞİL, şemaya dokunulmadı. İki ayrı tavan iki ayrı iş yapıyor:
      `QUOTA_MAX_POSTS_PER_DAY` (kayan 24 saat) **asıl koruma** çünkü tehdit hız;
      `QUOTA_MAX_POSTS` (ömür boyu) depolamayı bağlıyor. Ömür boyu tavan tek
      başına yetmiyordu — kaçak bir script tavanın tamamını tek seferde tüketir.
- [x] **F8 — kapatıldı (#42).** `Post.publishAt` + `publish-scheduled` cron'u.
      **Vercel Hobby planı yüzünden yarım çalışıyor** — bkz. "Açık işler → elle
      yapılacaklar". Cron yayının SONUCUNU ajansa bildiriyor; olmasaydı
      zamanlanmış yayın ajans için sessiz bir kutu olurdu.
- [x] **F9 — kapsam kararı verildi, aşağıda "Bilinçli kapsam dışı"da.**
- [x] **F10 — kapatıldı (#44).** Revizyon turu: `PostStatus.revision_requested`
      + `PostRevision` zinciri + `Post.revisionRound`.
- [x] **F11 — kapatıldı (#40).** E-posta uyarıları; Sentry ve yeni bağımlılık
      eklenmedi. **`ALERT_EMAIL` Vercel'e eklenmeden çalışmaz.**
      *Bilinen sınır:* uyarı bastırması process-içi bir `Map`; serverless'ta
      instance'lar arası paylaşılmaz, soğuk başlangıçta aynı hata için birden
      fazla mail gidebilir. Kalıcı çözüm DB/Redis ister.
- [x] **F12 — kapatıldı (#40).** `GET /api/health`, `SELECT 1` ile DB canlılığı.
      Public olduğu için yanıt bilerek sığ: sürüm/sayı/env/hata mesajı yok.
- [x] **F13 — kapatıldı** (F2'ye bindi).

## Bilinmesi gerekenler

**Prod göçleri `vercel-build` ile OTOMATİK uygulanıyor — merge = prod şema
değişikliği.** `package.json > vercel-build` = `prisma migrate deploy && next build`.
Yani master'a merge edilen bir migration, elle hiçbir şey yapılmadan prod
veritabanına gider. #40–#44 turunda üç migration (F8, F6, F10) bu yolla uygulandı
ve `_prisma_migrations` tablosundan `finished_at` dolu olarak doğrulandı.
*Sonuç:* hatalı bir migration doğrudan prod'u vurur, ayrı bir "deploy et" adımı
yok — bu yüzden şema göçleri merge ÖNCESİ boş DB + prod benzeri veriyle sınanmalı.

**Vercel env değişikliği çalışan deployment'ı ETKİLEMEZ — yeni deploy gerekir.**
`vercel env add` sonrası mevcut prod deployment eski değerlerle çalışmaya devam
eder. Aynı commit'i `vercel redeploy <deployment-url>` ile yeniden deploy etmek
yeterli (yeniden build eder, `migrate deploy` idempotent olduğu için zararsız) ve
alias otomatik yeni deployment'a taşınır.

**`vercel env add` bu projede varsayılan olarak SENSITIVE ekliyor.** Sır olmayan
değerler için `--no-sensitive` ver, yoksa değer bir daha geri okunamaz (bkz.
yukarıdaki sensitive maddesi). Eklendikten sonra `vercel env pull` ile değeri
gerçekten geri okuyarak doğrula — listede "Non-sensitive" görünmesi değerin
doğru olduğunu kanıtlamaz.


**Vercel Hobby planı cron'ları GÜNDE BİRE sınırlıyor — F8'in çözünürlüğü buna
bağlı.** Saatlik/dakikalık desenler deploy sırasında reddediliyor ve tanımlı tek
koşu da dakika hassasiyetinde değil (o saat içinde herhangi bir an, ±59dk).
Mevcut üç cron'un da günde bir olmasının sebebi bu. Zamanlanmış yayın koduna
bakıp "neden saatlik değil" diye sorulduğunda cevap burada — kod değil plan sınırı.

**`ALTER TYPE ... ADD VALUE` Prisma'nın transaction'ı içinde sorunsuz koşuyor
(PG 12+), AMA bu varsayılmadı — ölçüldü.** `vercel-build` prod'a
`prisma migrate deploy` uyguladığı için enum ekleyen her migration boş bir
veritabanında baştan sona koşularak doğrulanmalı:
```
docker exec cas-test-pg psql -U postgres -c "CREATE DATABASE chain_check;"
DATABASE_URL=...chain_check npx prisma migrate deploy
npx prisma migrate diff --from-url ...chain_check   --to-schema-datamodel prisma/schema.prisma --exit-code   # "No difference detected" beklenir
```
*Tuzak:* `migrate diff`'in bayrakları yanlış verilirse komut yardım metni basıp
**çıkış kodu 0** döner — yani "fark yok" gibi görünür. Çıktıda gerçekten
"No difference detected" yazdığını gör.

**Şema göçü olan bir migration'ı prod'a benzeyen VERİYLE sına, boş DB yetmez.**
F6'nın backfill'i (her ajans için `owner` üyesi) tam da bu yüzden kritikti: şema
değişikliği tek başına prod'u kırıyordu — üye satırı olmayan ajansın sahibi
deploy'dan sonra kendi verisine giremez ve girişte kendisine boş yeni bir ajans
açılırdı. Doğrulama şöyle yapıldı: boş DB → önceki sürümün şeması → prod'a
benzeyen veri (iki ajans, biri postlu) → yeni migration → sonuç sorgulandı.

**Yerel test veritabanı Docker'da ve otomatik ayakta değil.** `npm test`
`localhost:5455`'te Postgres bekliyor (`vitest.global-setup.ts` → `prisma db push`).
Konteyner yoksa testler tek satır kod okumadan patlar:
`docker run -d --name cas-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres
-e POSTGRES_DB=content_approval_test -p 5455:5432 postgres:16-alpine`


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

### 2026-08-26 — onay endpoint'i yayın anını da dönüyor

`GET /api/approve/[token]` yanıtına `publishedAt` eklendi (şema değişikliği yok,
kolon zaten vardı: `Post.publishedAt`, yayın anında `publish-post.ts` dolduruyor).

**Neden.** furi'nin yayın defteri yayın saatini iki kaynaktan öğrenebiliyor:
Instagram'ın media `timestamp`'i, ya da bu endpoint. Instagram'a ulaşamadığı
çalışmalarda ikincisi yoktu, `esitle.py` de eşitlemenin koştuğu anı yayın saati
olarak yazıyordu. Eşleşme çoğunlukla ERTESİ günün cron'unda kurulduğu için
defterdeki üç kayıt (24–26.08) bir gün ileri kaydı ve "bugün kaç post çıktı"
sorusunun cevabı yanlış oldu. Alan artık dönüyor; furi tarafı `publishedAt` boşsa
tespit anına düşüyor ama kaydı "tahmini" diye işaretliyor.

**Sır sızıntısı yok:** kolon yalnızca bir zaman damgası ve endpoint'te zaten
`publishStatus` / `igPermalink` gibi yayın alanları dönüyordu.

### 2026-08-23 — Faz J: CI (D1)

**PR: (faz-j/ci)** · `.github/workflows/ci.yml`, tek job (`dogrula`), tek dosya.
Kaynak kodda **hiçbir değişiklik yok** — depoda zaten var olan komutları
otomatikleştiriyor.

Adımlar sırayla: `npm ci` → `npx tsc --noEmit` → `prisma migrate deploy` →
şema kayması kontrolü → `npm test` → `npm run build`.

**Neden `migrate deploy` ayrı bir adım ve neden testlerden ÖNCE.** Testler
şemayı `prisma db push` ile kuruyor (`tests/vitest.global-setup.ts`), yani
`prisma/migrations/` klasörüne HİÇ bakmıyorlar. Bozuk, çakışan ya da eksik bir
migration bütün testler yeşilken merge edilebilirdi ve ilk belirtisi prod
deploy'unun patlaması olurdu — deponun en pahalı hata sınıfı tam olarak burada
gizliydi. Service container yeni ayağa kalktığı için o veritabanı boş; adım
prod'un yapacağı şeyin aynısını yapıyor. *Yan faydası:* testler artık
migration'larla kurulmuş şemaya karşı koşuyor, `db push` ürünü bir yaklaşığa
karşı değil.

**Şema kayması kontrolü ayrı bir adım.** Migration'ların koşması yetmez;
ürettikleri şema `schema.prisma` ile aynı olmalı, yoksa Prisma Client'ın
beklediği kolon prod'da olmaz. `prisma migrate diff --from-url ... --exit-code`
kullanılıyor, ama **`--exit-code`e tek başına güvenilmiyor**: deponun kayıtlı
tuzağı gereği yanlış bayrakla çağrılan `migrate diff` yardım metni basıp 0
dönüyor. Bu yüzden çıktıda gerçekten `No difference detected` yazdığı da
aranıyor.
*Kapının kapandığı ölçüldü:* `schema.prisma`ya geçici bir model eklenip
koşuldu → çıkış kodu **2**, grep eşleşmedi, adım düşerdi. Model geri alındı.
Kapının açık olduğu da ölçüldü: dokunulmamış şemada çıkış kodu 0, grep eşleşti.

**Tek veritabanı, tek konteyner.** Migration adımına ayrı bir DB açmak `psql`e
(runner imajının içeriğine) ya da ikinci bir service container'a bağımlılık
demekti; sıralama aynı garantiyi bedelsiz veriyor.

**Build'e sahte `AUTH_SECRET` veriliyor — bilinçli bir sözleşme.** Prod build'i
gerçek bir OAuth anahtarına ya da gerçek veriye ihtiyaç DUYMAMALI. Ölçüldü:
build çıktısında `/_not-found` dışındaki her yol `ƒ (Dynamic)`, yani hiçbir
sayfa build zamanında veritabanına gitmiyor. Bu adım bir gün gerçek sır
istemeye başlarsa düzeltilecek yer workflow değil, sırrı build zamanında okuyan
kod.

**Yerel doğrulama:** `npx tsc --noEmit` temiz · `npm test` 45 dosya / 578 test ·
`npm run build` başarılı · `migrate deploy` + kayma kontrolü boş DB'de iki yönde
de ölçüldü.

**Bilinçli kapsam dışı:**
- **Playwright (`npm run test:e2e`) CI'da koşmuyor.** Ayrı veritabanı
  (`content_approval_e2e`), ayrı port (3111), tarayıcı indirmesi ve
  `ENABLE_TEST_AUTH=1` istiyor; ilk iş akışını yavaş ve kırılgan yapardı.
  D8'in e2e boşluğuyla birlikte ayrı bir faz.
- **`npm audit` adımı yok.** Kalan 3 high bilinçli ve Next 16'ya bağlı (S3);
  kapıya koymak her koşuyu kırmızı yapardı.
- **Linter adımı yok** — depoda eslint diye bir şey yok, statik kapı `tsc`.
- **Branch protection workflow'un parçası değil** — repo yapamaz, GitHub ayarı.
  *Aynı gün elle açıldı;* ayrıntısı "Elle yapılması gerekenler"deki kapanmış
  maddede.

### 2026-08-22 — Faz E–I: güvenlik hijyeni, kota, zamanlanmış yayın, ekip, revizyon

Beş yığılmış PR (#40–#44). Taban 353 test → **527 test**. Her turda `npm test`,
`npx tsc --noEmit` ve `npm run build` yeşil; şema göçü olan iki PR'ın migration
zinciri boş veritabanında `migrate deploy` ile ayrıca koşuldu.

**#40 — güvenlik hijyeni + operasyon görünürlüğü** (S3, S5, S6, S7, S8, F11, F12).
Kalan güvenlik maddelerinin hiçbiri sömürülebilir değildi; tur derinlemesine
savunmaydı. F11/F12 ise gerçek bir kör noktayı kapattı: her şey `console.error`
ile Vercel loglarına gidip kimseye ulaşmıyordu.

**#41 — kota tavanları** (F7). Asıl bulgu: ömür boyu tavan tek başına bir HIZ
sınırı değil, kaçak bir script onu tek seferde tüketebilir. Günlük kayan pencere
eklendi; ömür boyu tavan yalnızca depolamayı bağlıyor.

**#42 — zamanlanmış yayın** (F8). Onay kararı ve `publishStatus` aynı
transaction'da yazılıyor — aksi halde cron `approved` ama `idle` bir postu
yakalayıp erken yayınlayabilirdi. Cron sonucu ajansa bildiriyor.

**#43 — ekip üyeleri** (F6). En riskli göç: backfill olmadan şema değişikliği
tek başına prod'u kırıyordu. JWT bayatlığı 5 dakikalık yeniden doğrulamayla
çözüldü. Davet kabulü token'dan değil e-postadan sorgulanıyor — token tabanlı
kabulde linki ele geçiren herkes ajansa girerdi.

**#44 — revizyon turu** (F10). `rejected` her yerde "yolun sonu" olarak
okunduğu için revizyon ayrı bir `PostStatus` değeri oldu; aynı değeri
paylaşsalardı mevcut kollar revizyonu sessizce gömerdi. `ApprovalAudit` bu işi
yapamazdı: `ip` zorunlu, serbest metin alanı yok ve asıl eksik olan **sürüm** —
hangi metne itiraz edildiği. `PostRevision.caption` her satırda o anki metni
donduruyor.

**Prod temizliği.** 22 Temmuz'dan kalma iki boş test ajansı
`bos-ajans-temizligi.mjs --apply` ile silindi (4 → 2 ajans, tek transaction,
atlanan yok). Bu sırada TODOS'ta kaydı olmayan üçüncü bir boş ajans bulundu —
sebebi F6'nın kendisiydi, "Açık işler"e işlendi.


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
      **2026-08-23 notu: bu karar GERİ ALINDI, depo yeniden public.** Gerekçesi ve
      bugün geçerli olan yazım kuralı için "Depo görünürlüğü" bölümüne bak. Madde
      tarihsel kayıt olarak duruyor.

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
