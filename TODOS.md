# TODOS

Son güncelleme: 2026-08-17. Canlı: https://content-approval-saas.vercel.app

---

## Açık işler

### Doğruluk

- [ ] **Aynı içerik Instagram'a iki kez yayınlanabiliyor** — `externalRef` üzerinde mükerrer
      yayın koruması yok. Kanıt prod'da duruyor: `externalRef='dizi/long-story-short'` iki ayrı
      posta bağlı, **ikisi de** `publishStatus='published'`, farklı permalink'lerle
      (`cmsvyzi1w0001ju04qoih8gjp` 15:38 ve `cmsw1t4mv0001ky046csgssb5` 16:57).
      furi aynı içeriği iki kez gönderirse Instagram'a iki kez düşüyor — gözetimsiz cron'da
      bu sessizce tekrarlanır.
      **Dikkat — basit benzersizlik kısıtı ÇÖZÜM DEĞİL.** 2026-08-17 elle testinde ortaya
      çıktı: furi'nin `esitle.py`'si "yayınlandı ama sonra Instagram'dan silindi" durumunda
      içeriği bilerek havuza geri döndürüyor (`yayinlandi_sonra_silindi`). Yani aynı
      `externalRef`'in ikinci kez gönderilmesi **meşru bir kurtarma yolu**. `(agencyId,
      externalRef)` üzerine `@@unique` koymak bu yolu kırar, "bu ref zaten yayınlanmış mı"
      kontrolü de aynı şekilde.
      *Yapılacak:* ayrım gözeten bir kontrol gerek — ör. yalnızca **canlıda duran**
      (`publishStatus='published'` ve permalink hâlâ erişilebilir) bir ref için tekrar
      gönderimi engellemek, ya da furi'nin `esitle.py`'de silinen postun SaaS kaydını da
      kapatması (`publishStatus`'ü geri alması) böylece ref serbest kalması.
      Kısıt yine de tercih edilirse mevcut çift kayıt önce temizlenmeli, yoksa migration patlar.

### Güvenlik

- [ ] **Apps Script'te canlı GitHub token'ı duruyor** — script.google.com'daki proje hâlâ
      etkin olabilir ve `FURI_GITHUB_TOKEN` property'sinde gerçek bir token tutuyor.
      Zincir furi PR #2 ile emekliye ayrıldı, yani token artık gereksiz ama açıkta.
      *Yapılacak:* tetikleyiciyi ve property'yi elle sil, sonra token'ı GitHub'dan iptal et.
      Adımlar `furi/emekli/README.md` içinde. **Repo bunu yapamaz, elle yapılmalı.**

### Takvimli

- [ ] **Instagram token'ı 2026-10-15'te doluyor** — dolduğunda yayın durur
      (`publishStatus='failed'`). Dashboard uyarısı 2026-10-05'te çıkacak.
      *Dikkat:* token'ın **iki kopyası** var — SaaS'ta `Client.instagramAccessToken`,
      furi tarafında ortam değişkeni. Senkron tutan bir mekanizma yok, yenilerken
      **ikisini birden** güncelle.
      Yenileme: `GET /refresh_access_token?grant_type=ig_refresh_token&access_token=<mevcut>`

- [ ] **Otomatik token yenileme yok** — bugün ajans uyarıyı görüp elle yeniliyor.
      Yenileme çağrısını bir cron'a bağlayıp `instagramTokenExpiry`'yi de güncellemek gerek
      (furi'deki `scripts/ig_token.py` örnek). Yukarıdaki maddeyi kalıcı olarak kapatır.

### Temizlik

- [ ] **22 Temmuz'dan kalma çöp veri** — `Enes Memduh` / `enes can` ajansları altında
      `"asd"`, `"gfh"`, `"as"`, `"sdf"` başlıklı 6 test postu prod'da duruyor. Zararsız
      ama prod'u kirletiyor. Silme sırası: `ApprovalAudit`, `ApprovalLink`, `PostImage`,
      `Post`, `Client`.

### Bilinçli kapsam dışı

- [ ] **Toplu reddetme** — reddetme sebebi post başına anlamlı olduğu için toplu onayın
      simetriği yapılmadı. Yeniden değerlendirilirse "ortak sebep" alanı gerekir.

---

## Bilinmesi gerekenler

**`.env.local` iki ayrı adres tutuyor.** `DATABASE_URL` → **localhost** (Docker, port 5455);
prod Neon adresi **`POSTGRES_URL`** altında. Prisma varsayılanıyla bağlanan bir betik prod'a
değil yerel DB'ye düşer. Prod'a yazmadan önce bağlandığın hostu **doğrula** —
bu tuzak 2026-08-16'da prod temizliği sırasında bir kez yakalandı.

**Yayın süresi.** Instagram `POST /{ig}/media` görseli senkron indirdiği için slayt başına
~8.5 sn. Karusel container'ları bu yüzden paralel oluşturuluyor; sıralı yapılırsa 60 sn
Vercel tavanı aşılır. Toplu yayının yapılmama sebebi de bu.

**Deploy.** Proje GitHub'a bağlı (2026-08-17'de bağlandı): master'a merge → production,
PR → preview. Elle deploy gerekmiyor.

---

## Tamamlananlar

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
