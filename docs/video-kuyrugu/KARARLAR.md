# Video kuyruğu — karar günlüğü

Her karar: tarih, karar, gerekçe. Yeni karar en alta eklenir; eski karar
değişirse silinmez, üstü çizilip yenisine bağlanır — neden alındığını bilmeden
neden geri alındığı anlaşılmaz.

---

### K1 · 2026-09-25 · Video işlenmez, yalnızca caption üretilir
İlk taslakta ışık/renk ayarı ve altyazı gömme (subtitle-pipeline aşamaları)
vardı. Kullanıcı çıkardı: "videoda işlem kısmını boşver, sadece caption."
Sonuç: ffmpeg yok, worker yok, her şey Vercel'de.

### K2 · 2026-09-25 · Ayrı sunucu yok; özellik content-approval-saas içine
Oracle Always Free / ev bilgisayarında Docker worker değerlendirildi (K1'den
önce, ffmpeg gerekiyordu). K1 ile gereksizleşti. Onay, iki fazlı Reels yayını,
token yenileme, e-posta ve IDOR kalıpları burada hazır ve testli.

### K3 · 2026-09-25 · Onay kullanıcının tercihi (`requireApproval`)
Kullanıcı: "onay gelmesini istemese bile video otomatik yayınlanabilsin."
Varsayılan **açık** (güvenli taraf). Kapalıyken yayın `ApprovalAudit`'e
`auto_approved` olarak yazılır ki kimin/neyin karar verdiği izlenebilsin.

### K4 · 2026-09-25 · Her yayın sonucu e-postayla bildirilir
Başarı (link) ve hata (neden) her zaman, onay modundan bağımsız. Ek olarak
her iki modda "yarın şu yayınlanacak" hatırlatması — onay kapalıyken
kullanıcının son görme şansı bu.

### K5 · 2026-09-25 · Depolama Cloudflare R2, bucket gizli, imzalı URL
Kullanıcı kararı. Gerekçe: 10 GB ücretsiz + ücretsiz dışarı aktarım (video
portalda izleniyor, Instagram ve fal indiriyor). Public bucket / `r2.dev`
yerine süreli imzalı URL: alan adı gerekmez, erişim kapsam kontrolünden sonra
üretilir. Açık risk: Instagram'ın imzalı URL'den çekip çekemediği (V1'de
doğrulanacak). Mevcut Blob akışı yerinde kalır.

### K6 · 2026-09-25 · Önce Furkan, yapı çok müşterili
Stil `Client.captionStyle` alanında, ayarlar `PublishSettings`'te müşteri
başına. İlk sürümde yalnızca bir müşteri doldurulur; kayıt/faturalama yok.

### K7 · 2026-09-25 · Zamanlama QStash ile (5 dk tick)
Vercel Hobby cron'u günde bir ve ±59 dk. Para harcanmayacağı için Pro yok.
QStash zaten kullanılan Upstash'in parçası; günde 288 tick. Günlük Vercel
cron'ları güvenlik ağı.

### K8 · 2026-09-25 · Kaçırılan slot telafi edilmez
Slot saatinden 1 saatten fazla geçmişse yayın yapılmaz, `skipped` yazılır.
Aksi halde bir kesinti sonrası birikmiş videolar art arda yayınlanır —
sayfa için kötü, kullanıcının seçtiği ritmi bozar.

### K9 · 2026-09-25 · Onay açıkken sıradaki ilk ONAYLI video yayınlanır
Alternatif "baştaki onaylanmadıysa slotu boş geç"ti. Seçilen yol yayın
ritmini korur; kullanıcı istemediği videoyu zaten onaylamamış olur.
Hiç onaylı yoksa slot boş geçer ve e-posta gider.

### K10 · 2026-09-25 · Yükleme anında caption, arka planda QStash ile
Toplu yüklemede (20 video) tek istekte hepsini üretmek 60 sn'yi aşar.
Video başına ayrı QStash mesajı: her biri kendi fonksiyonunda, otomatik
tekrar denemeli.

### K11 · 2026-09-25 · Kareler tarayıcıda çıkarılır
Konuşmasız videoların (kâğıda yazı yazma) caption'ı için görsel bağlam şart.
Sunucuda ffmpeg olmadığı için `<video>` + `canvas` ile 6 kare tarayıcıda
alınır.

### K12 · 2026-09-25 · Caption modeli `claude-sonnet-5`
Maliyet. Caption kısa ve kurallı bir iş; kalite yetmezse model tek satırda
değişir.

### K13 · 2026-09-25 · Faz adları V0–V5
TODOS.md'de F1–F14 ürün boşluklarına ait; karışmasın diye bu işin fazları
"V" (video kuyruğu) önekini kullanır.

---

## Açık sorular

- **R2 10 GB'a yaklaşınca?** Yayınlanmış videoları silmek mi (Instagram'da
  kopyası var), ücretli katmana geçmek mi — kullanıcı karar verecek. Bugün
  20 video × ~50 MB ≈ 1 GB.
- **Müşteri caption'ı düzenledikten sonra "yeniden üret" basarsa** elle
  yapılan düzenleme kaybolur — onay diyaloğu yeterli mi, eski sürüm mü
  saklanmalı? V3'te karar.
