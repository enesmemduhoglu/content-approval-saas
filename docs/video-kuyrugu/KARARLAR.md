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

### K14b · 2026-09-25 · fal, R2 imzalı URL'i okuyor (doğrulandı)
99 MB'lık örnek video gizli bucket'a yüklendi, 1 saatlik imzalı GET URL'i
`audio_url` olarak verildi: Whisper 15.8 sn'de transkript döndü. Bucket'a
imzasız erişim reddediliyor; CORS ön kontrolü canlı adres ve localhost için
204. Açık kalan tek dış doğrulama: Instagram'ın imzalı URL'den Reels
konteyneri kurması (test hesabı gerekiyor).

### K20 · 2026-09-25 · QStash US bölgesinde
Neon `us-east-1`, Vercel fonksiyonları varsayılan `iad1`: QStash'in de US
bölgesinde olması her tick'in okyanus aşmasını önlüyor. Token/imza anahtarları
bölgeye özel olduğu için `QSTASH_URL` zorunlu ve `qstash.ts`'te açıkça
veriliyor.

### K21 · 2026-09-25 · Instagram, R2 imzalı URL'den Reels kuruyor (doğrulandı)
Furkan'ın hesabında, 1 saatlik imzalı R2 URL'iyle Reels container'ı açıldı:
31 sn'de `FINISHED`. `media_publish` BİLİNÇLİ OLARAK çağrılmadı — asıl
bilinmeyen Instagram'ın gizli bucket'tan indirebilmesiydi, yayın adımı zaten
mevcut testli kod. Yayınlanmayan container 24 saatte düşüyor; hesapta iz yok.
Böylece planlanan dış doğrulamaların hepsi tamamlandı (K14b, K20, K21).
Prod'da QStash imzası da doğrulandı: imzasız/sahte imza 401, gerçek mesaj 200.

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

### ~~K22 · 2026-09-25 · Yüklemede 1:1 kırpma, tarayıcıda~~ → K24 ile iptal
Sayfa videoları dikey çekip kare yayınlıyor; ilk canlı yayın dikey çıktı.
Kullanıcı kararları: son görünüm yalnızca kare (dolgu/yazı yok); çerçeve
varsayılan orta, kaydırılabilir; video başına "Kare / Orijinal", varsayılan
kare. Kırpma sunucuda değil kullanıcının tarayıcısında (Mediabunny,
WebCodecs): ücretsiz, 60 sn sınırı yok, K2 bozulmuyor. Kırpma başarısızsa
sessizce orijinale düşülmez, kullanıcıya sorulur. Ayrıntı:
[`V6-kare-kirpma.md`](V6-kare-kirpma.md).

### K23 · 2026-09-25 · Portal PWA olacak; iOS için kodla giriş (V7)
Yükleme telefondan yapılacak. Yerel uygulama (App Store) yerine PWA: ücret ve
inceleme yok, kod tabanı aynı. iOS'ta ana ekran PWA'sının çerezleri
Safari'den ayrı olduğu için magic link PWA'da oturum açmıyor → e-postaya 6
haneli, tek kullanımlık, hash'li, 5 deneme sınırlı kod. Service worker API ve
oturumlu yanıtları asla önbelleğe almaz. Kullanıcı kararları: kapsam V7a
(kurulum + kodla giriş) + V7b (parçalı, kaldığı yerden devam eden yükleme) +
V7c (Web Push bildirim, e-posta yedek) + V7d (Android paylaşım hedefi);
öncelikli cihaz iPhone; uygulama adı ve ikonu **sayfaya özel** (dinamik
manifest, `Client.app*` alanları). Ayrıntı: [`V7-pwa.md`](V7-pwa.md).

### K24 · 2026-09-25 · V6 (kare kırpma) iptal — video telefonda hazırlanır
K22'yi geri alır. Kullanıcı: "videolar her zaman kare olmayabilir, farklı
türde videolar da yüklenebilir"; kırpma ve renk ayarını yükleyen kişi
telefonda yapacak (iPhone Fotoğraflar'da Kırp → en-boy oranı → Kare var).
Tarayıcıda kırpmanın riskleri (iPhone rotasyon üst verisi, HEVC/WebCodecs
desteği, telefon ısınması) hiç doğmuyor; K1 ("video işlenmez") aynen
geçerli. "Kare değilse uyar" önerisi de videolar kare olmak zorunda
olmadığı için alınmadı.

### K25 · 2026-09-25 · Müşteri oturumu kaydırmalı (V7a)
PWA'da her 30 günde bir yeniden giriş istemek (kod beklemek) kötü deneyim.
Çerez kalan süre 15 günün altına düşünce yenilenir: kullanılan cihaz hiç
düşmez, bırakılan cihaz 30 günde düşer; oturum zaten her istekte DB'den
doğrulandığı için erişim kaldırma anında etkili kalır.

### K26 · 2026-09-25 · PWA kapsamı `/portal` (eğik çizgisiz) + kod denemelerine günlük tavan (V7a)
Kapsam eşleşmesi düz önek karşılaştırması: `/portal/` kapsamı açılış sayfası
`/portal`'ı kapsamaz, `start_url` kapsam dışına düşer ve en çok açılan
sayfada çevrimdışı yedek çalışmaz. Bu yüzden manifest `scope` ve SW kaydı
`/portal`. Kod girişinde token başına 5 deneme tek başına yetmiyor (dakikada
yeni kod istenerek günde ~21 bin tahmin, ~%2 isabet) → kullanıcı başına 24
saatte 20 hatalı kod tavanı; tavan yalnızca kod yolunu kapatır, link çalışır.
Manifest `<link>`'i `crossorigin="use-credentials"` ile elle yazılıyor: Next
15.5 bunu yalnızca preview'da ekliyor; çerezsiz istenen manifest Android'de
uygulamayı hep varsayılan adla kurardı. Oturum yenileme `POST
/api/portal/session` + görünmez `SessionKeeper` (middleware yok).

### K27 · 2026-09-25 · Uygulama ikonu Furkan'ın kendi illüstrasyonundan
İlk ikon (genel çizgi karakter) ve referanslı üretilen adaylar kullanıcı
tarafından beğenilmedi (renkler; saç uçlarının sarıya kaçması). Kullanıcı
sayfanın mevcut illüstrasyonunu verdi: yeşil halka ve beyaz köşeler görselin
kendi krem zeminiyle (`#F2E4D3`) dolduruldu, yüze odaklı kare kesit alındı,
set `scripts/pwa-ikon-uret.mjs` ile üretildi (`public/icons/furkan-teacher/`).
Yeni model çağrısı yok.

### K28 · 2026-09-26 · Yayın günleri: tek gün kümesi × tek saat listesi (V8)
Kullanıcı her gün yayın istemeyebilir ("yalnız Pzt/Per/Cum", "yalnız
Pazartesi 19:00"). Model: `PublishSettings.days Int[]` (ISO 1 = Pazartesi … 7
= Pazar, müşterinin `timezone`'una göre YEREL gün); `slots` her seçili günde
geçerli. **En az bir gün zorunlu** — hiç yayın istemeyenin yolu "Yayını
duraklat", iki ayrı "kapalı" hâli olmasın. **Güne göre farklı saat YOK**
("Pzt 09:30, Cum 19:00"): ekranda iki satırlık ayar ve tek filtre yeterli;
istenirse `schedule: {day, time}[]` modeline geçilir (açık soru). Varsayılan
tüm günler: göç mevcut ayarları değiştirmez. K8 (kaçan slot telafi edilmez)
aynen geçerli; seçili olmayan günde slot hiç doğmaz, `SlotRun` de yazılmaz.
Belge: [`V8-yayin-gunleri.md`](V8-yayin-gunleri.md).

### K29 · 2026-09-25 · Giriş ekranı kimliği: imzalı iz çerezi (V7)
K23'ün "oturum yokken nötr kimlik" kuralı, oturumu düşen Furkan'ın kendi
uygulamasını ana ekrandan açıp "VİDEO KUYRUĞU" görmesine yol açıyordu. Başarılı
girişte (link ve kod — ortak `setClientSessionCookie`) ve kaydırmalı yenilemede
`cas_portal_kimlik` çerezi yazılır: yükü yalnızca `clientId` + bitiş, AUTH_SECRET'ten
ayrı etiketle (`cas-portal-kimlik-v1`) türetilmiş anahtarla HMAC-imzalı, `k1`
önekli; `httpOnly`, `secure` (prod), `sameSite=lax`, `path=/portal` (API'lere hiç
gitmez), **1 yıl**. Oturum yokken giriş ekranı, iOS meta'sı ve manifest bu izden
yalnızca **ad, ikon ve tema rengini** çözer; oturum varsa oturum kazanır; imza
tutmuyor, süresi dolmuş ya da müşteri silinmişse varsayılan. İz hiçbir yetki
vermez (oturum kontrolleri ona bakmaz; izli-oturumsuz istek 401). **Çıkışta
silinmez** — amacı tam da oturum gittikten sonra markayı göstermek; cihaz o
uygulamayı zaten o ad ve ikonla taşıyor. Aynı cihazda başka müşteriye girilirse
iz ona geçer (son giriş kazanır). Portal kullanıcısı silinse de iz müşteri
durdukça markayı göstermeye devam eder — bilinen, kabul edilmiş sınır.
Bu değişiklikten önce giriş yapmış cihaz izi ilk yeniden girişte ya da oturum
yenilemesinde alır.

---

## Açık sorular

- **V7 ikon deposu:** ilk sürümde `public/icons/<müşteri>/`; çok müşteride
  Blob mu — V7a'da karar.
- **Preview'da test:** R2 CORS preview adreslerini kapsamıyor — V7'de karar.

- **R2 10 GB'a yaklaşınca?** Yayınlanmış videoları silmek mi (Instagram'da
  kopyası var), ücretli katmana geçmek mi — kullanıcı karar verecek. Bugün
  20 video × ~50 MB ≈ 1 GB.
- **Müşteri caption'ı düzenledikten sonra "yeniden üret" basarsa** elle
  yapılan düzenleme kaybolur — onay diyaloğu yeterli mi, eski sürüm mü
  saklanmalı? V3'te karar.
