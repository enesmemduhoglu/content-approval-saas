# TODOS

Son güncelleme: 2026-08-17 (ikinci tur merge'lerinden sonra).
Canlı: https://content-approval-saas.vercel.app

**Açık PR yok, açık issue yok.** #21, #22 ve #23 merge edildi; `master` = `origin/master`.
Prod envanteri (2026-08-17, ölçüldü): **3 ajans / 1 müşteri / 6 post** — çöp veri kalmadı.

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


### Doğruluk

- [ ] **furi'nin token kopyası bayatlayacak** — #21'in yan etkisi, yeni iş.
      Instagram token'ının iki kopyası var: SaaS'ta `Client.instagramAccessToken`,
      furi'de ayrı bir ortam değişkeni. Senkron mekanizması yok. Cron SaaS kopyasını
      yenileyince Instagram eskisini kısa süre sonra geçersiz kılıyor → **furi sessizce
      kırılır**. İlk gerçek yenileme ~**2026-09-25** (token 2026-10-15'te doluyor,
      pencere 20 gün) — pratik son tarih buydu.
      **Çözüm yazıldı, merge bekliyor: SaaS PR #29 + furi PR #3.**
      Tek kaynak yaklaşımı: furi kendi kopyasını hiç tutmuyor, token'ı her çalışmada
      `GET /api/clients/[id]/instagram-token` üzerinden SaaS'tan çekiyor.
      *Merge sırası önemli:* **önce SaaS merge + deploy, sonra furi.** Ters sırada furi
      henüz var olmayan bir uca istek atar.
      *Sonrasında elle:* furi'nin yerel `.env`'inden `IG_ACCESS_TOKEN` ve `IG_USER_ID`
      satırlarını sil — artık hiçbir yerde okunmuyorlar ama duran sır gereksiz risk.
      Yeni env değişkeni **gerekmiyor**; `FURI_API_KEY`, `FURI_API_AGENCY_ID`,
      `FURI_SAAS_URL`, `FURI_CLIENT_ID` zaten tanımlı.
      *Merge sonrası doğrula:*
      `python .claude/skills/insta-yayinla/scripts/ig_token.py --kontrol`
      (uçtan uca gerçek doğrulama SaaS deploy edilmeden yapılamıyordu).

### Bilinçli kapsam dışı

- [ ] **Toplu reddetme** — reddetme sebebi post başına anlamlı olduğu için toplu onayın
      simetriği yapılmadı. Yeniden değerlendirilirse "ortak sebep" alanı gerekir.

---

## Bilinmesi gerekenler

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
