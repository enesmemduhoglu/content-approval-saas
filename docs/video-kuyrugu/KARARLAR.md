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

### K14 · 2026-09-25 · fal Whisper mp4'ü doğrudan kabul ediyor
V2'de gerçek videoyla denendi (fal deposu URL'i; `.mov` da kabul edildi).
R2 imzalı URL ile deneme anahtarlar gelince yapılacak. Whisper süresi çok
değişken: aynı 33 sn video soğuk başlangıçta 65 sn, sonra 5–21 sn. Whisper'a
30 sn bütçe; aşarsa post `failed` (tekrar denenebilir) olur, QStash tekrar
dener — yarıda bırakılan fal işi fal tarafında yine ücretlenir (birkaç sent).

### K15 · 2026-09-25 · altText şimdilik saklanmıyor
Claude alt text üretiyor ama portal postunda (Reels) onu tutacak alan yok;
`PostImage.altText` görsel satırına ait. Şema kararı bekliyor — Instagram
Reels API'sinin alt text alıp almadığı da o kararın parçası.

### K16 · 2026-09-25 · Uydurma yasağı kanca ve nota da uygulanır
İlk prompt sürümü "yaygın yanlış" kancasını ve "Küçük not"u videoda
olmayan içerikle doldurdu; kaynağı stil belgesindeki kalıplardı. Prompt'a
"her cümlenin dayanağını kontrol et" eklendi, `caption-stili.md` yumuşatıldı.
Ayrıca Whisper sayıları yanlış duyabiliyor ("15" → "50"): portal caption'ın
otomatik üretildiğini ve kontrol edilmesi gerektiğini söyler.

### K17 · 2026-09-25 · Günlük özetin tekrar koruması süreç içinde
"Bugün gönderildi" bilgisi bellekte; aynı gün farklı bir soğuk instance'ta
ikinci tetik olursa özet iki kez gider. Tam çözüm `PublishSettings`'e bir
kolon (şema). Günlük cron günde bir koştuğu için kabul edildi.

### K18 · 2026-09-25 · Instagram bağlı değilse slot video harcamaz
Token yok ya da süresi dolmuşsa slot `failed` yazılır, müşteri ve ajans
e-posta alır, video kuyrukta kalır — bir sonraki slotta tekrar denenir.

### K19 · 2026-09-25 · Portal davranış kararları (V3)
- Yükleme taslağı `status: draft` ile başlar, `complete` onu `pending` yapar:
  yarım kalan yükleme hiçbir akışa girmez ve "kuyruktan çıkarılmış" videodan
  ayrılır (ikisinde de `queuePosition` null).
- Red videoyu kuyruktan da çıkarır. Onay için caption `ready` olmalı.
- Yeniden üretme onaylı videonun onayını geri alır (yeni metni kimse görmedi).
- "Tekrar dene" `failed → idle` + `slotAt` temizlenir; "sona at" çıkarılmış
  videoyu geri alır.
- Magic link GET'te harcanmaz, sayfadaki buton POST'la tüketir: e-posta
  tarayıcılarının linki önceden açması tek kullanımlık token'ı yakmasın.
- Giriş maili yanıttan sonra (`after()`) gider: yanıt süresinden adresin kayıtlı
  olup olmadığı anlaşılmasın.
- Süre (≤ 90 sn) ve dikeylik yalnızca tarayıcıda kontrol ediliyor; tarayıcının
  açamadığı video (bazı HEVC .mov) karesiz yüklenir. Instagram yine reddederse
  yayın `failed` olur ve e-posta gider.
- Kapsam dışı: "tüm cihazlardan çık", yeniden üretmede eski caption sürümü,
  ajans panelinde kuyruk görünümü.

---

## Açık sorular

- **R2 10 GB'a yaklaşınca?** Yayınlanmış videoları silmek mi (Instagram'da
  kopyası var), ücretli katmana geçmek mi — kullanıcı karar verecek. Bugün
  20 video × ~50 MB ≈ 1 GB.
- **Müşteri caption'ı düzenledikten sonra "yeniden üret" basarsa** elle
  yapılan düzenleme kaybolur — onay diyaloğu yeterli mi, eski sürüm mü
  saklanmalı? V3'te karar.
