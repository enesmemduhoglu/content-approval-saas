# TODOS

Son güncelleme: 2026-08-17. Canlı: https://content-approval-saas.vercel.app

---

## İnceleme bekleyen PR'lar

Üçü de açık ve master'a karşı `MERGEABLE`. **Ama #21 ile #23 birbirine değiyor** —
ikisi de `src/lib/instagram.ts` ve `src/lib/instagram.test.ts` dosyasına aynı bölgeye
(`fetchInstagramAccount` sonrası) fonksiyon ekliyor. Test birleştirmesi yapıldı:
hangisi ikinci merge edilirse **çakışacak**. Sıralı merge et, ikincisinde
`git merge master` ile çakışmayı çöz — iki fonksiyon da korunmalı, biri diğerinin
yerine geçmiyor.

- **#23 — mükerrer yayın koruması** (`fix/mukerrer-yayin-korumasi`)
- **#21 — otomatik token yenileme** (`feat/otomatik-token-yenileme`)
- **#22 — prod temizlik betiği** (`chore/prod-test-verisi-temizligi`) — diğer ikisiyle
  dosya kesişimi yok, bağımsız merge edilebilir.

---

## Açık işler

### Elle yapılması gerekenler (repo yapamaz)

- [ ] **Apps Script'te canlı GitHub token'ı duruyor** — script.google.com'daki proje hâlâ
      etkin olabilir ve `FURI_GITHUB_TOKEN` property'sinde gerçek bir token tutuyor.
      Zincir furi PR #2 ile emekliye ayrıldı, yani token artık gereksiz ama açıkta.
      *Doğrulandı (2026-08-17):* token furi1 reposunda **hiçbir yerde hardcode değil**,
      yalnızca Apps Script property'sinde. Yani tek çözüm elle silmek.
      *Adımlar:* script.google.com → `furi-onay-tetikleyici` → **Triggers** → `onayKontrol`
      tetikleyicisini sil → **Project Settings → Script Properties** → `FURI_GITHUB_TOKEN`
      sil → GitHub'da token'ı iptal et (github.com/settings/tokens) → tetikleyici issue #1
      kapatılabilir. Ayrıntı: `furi1/.claude/skills/insta-yayinla/emekli/README.md`.

- [ ] **`CRON_SECRET` Vercel env'e eklenmeli** — #21 merge edilmeden ya da hemen sonra.
      Eklenmezse cron endpoint'i her gece 401 döner ve **yenileme hiç çalışmaz**;
      sistem sessizce eski (elle yenileme + uyarı şeridi) davranışına düşer.
      Cron tanımı yalnızca deploy ile kaydolur — merge production deploy'u tetikliyor,
      elle `vercel deploy` gerekmiyor. Sonra Vercel → Settings → Cron Jobs'tan listelendiğini
      doğrula ve ilk koşuda `[cron:ig-token]` loglarına bak.
      *Son tarih:* "Furkan Teacher" müşterisinin token'ı **2026-10-15'te doluyor**;
      dolarsa yayın durur (`publishStatus='failed'`). Cron çalışır hâle gelirse bu tarih
      kalıcı olarak sorun olmaktan çıkar — çıkmazsa 2026-10-05'te dashboard uyarısı gelecek
      ve elle yenilemek gerekecek (SaaS **ve** furi kopyası, ikisi birden).

- [ ] **Prod çöp verisini gerçekten sil** — #22'nin betiği yazıldı ve dry-run'ı prod'a karşı
      çalıştırıldı, ama **silme yapılmadı**. Dry-run sonucu: 6 post, 8 görsel, 6 approval
      link, 6 audit, 2 müşteri; 0 ajans. Yayın izi (`published` / `igMediaId` / `igPermalink`)
      olan **hiçbir** aday çıkmadı, yani koruma filtresi bu turda bir şey elemedi.
      *Çalıştır:* `node scripts/prod-test-verisi-temizligi.mjs --apply`
      Transaction hatası gelirse `DB_URL_ENV=POSTGRES_URL_NON_POOLING` ile tekrarla —
      varsayılan `POSTGRES_URL` pooled (pgbouncer) adres.


### Doğruluk

- [ ] **furi'nin token kopyası bayatlayacak** — #21'in yan etkisi, yeni iş.
      Instagram token'ının iki kopyası var: SaaS'ta `Client.instagramAccessToken`,
      furi'de ayrı bir ortam değişkeni. Senkron mekanizması yok. Cron SaaS kopyasını
      yenileyince Instagram eskisini kısa süre sonra geçersiz kılıyor → **furi sessizce
      kırılır**. Bugünkü hâliyle cron her yenilediğinde furi env'ini elle güncellemek
      gerekiyor; bu tekrar eden bir angarya.
      *Kalıcı çözüm:* tek kaynak — furi token'ı SaaS API'sinden çeksin, ya da yenileme
      sonrası furi env'i de programatik güncellensin. furi ayrı repo.

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
      iddiası doğrulandı. **Silme henüz yapılmadı.** (PR #22)

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
