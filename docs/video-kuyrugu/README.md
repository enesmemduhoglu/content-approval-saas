# Video kuyruğu — tasarım belgesi

> **Yeni oturum mu?** Önce [`FAZLAR.md`](FAZLAR.md)'deki "Oturum devri" bölümünü oku.
> Kararların gerekçeleri [`KARARLAR.md`](KARARLAR.md)'de, caption kuralları
> [`caption-stili.md`](caption-stili.md)'de.
> **Planlanan (uygulanmadı):** [V6 — kare kırpma](V6-kare-kirpma.md),
> [V7 — PWA](V7-pwa.md).

Başlangıç: 2026-09-25. İlk müşteri: @furkanteacherteaching (Türklere İngilizce
öğreten kısa Reels). Yapı çok müşterili kurulur ki sonra başka sayfalara da
sunulabilsin.

## 1. Amaç

Sayfa sahibinin yaptığı **tek iş video yüklemek** olsun:

1. Kullanıcı istediği zaman video yükler — tek tek ya da toplu (ör. 20 tane).
   Videolar depolanır ve bir **kuyrukta** birikir.
2. Yükleme anında her video için **caption üretilir** (açıklama + hashtag +
   alt text). Videonun kendisine **hiçbir işlem yapılmaz** — ışık ayarı,
   altyazı, kırpma yok. *(Planlanan: yüklemede isteğe bağlı 1:1 kırpma,
   tarayıcıda — V6 / K22.)*
3. Kullanıcı kuyruğu görür, **sırayı değiştirir**, caption'ı düzenler ya da
   yeniden ürettirir.
4. Kullanıcı yayın saatlerini seçer (ör. günde 1 video, 19:00). Her saatte
   kuyruktaki sıradaki **uygun** video Instagram'a yayınlanır.
5. **Onay kullanıcının tercihidir.** Açıksa yalnızca onaylanan video yayınlanır;
   kapalıysa sırası gelen video onay beklemeden yayınlanır.
6. **Her yayın sonucu e-postayla bildirilir** — başarıda Instagram linkiyle,
   hatada nedeniyle. Onay kapalı olsa bile.

Bugünkü akış (karşılaştırma için): furi1 reposunda Reels elle hazırlanıyor,
caption elle yazılıyor, `saas_gonder.py` ile tek tek bu SaaS'a gönderiliyor,
onay e-postadaki linkten veriliyor ve onayla birlikte anında yayınlanıyor.

## 2. Mimari

```
Kullanıcı (telefon / PC)
   │  yükle · sırala · caption düzenle · onayla · ayarlar
   ▼
content-approval-saas (Vercel Hobby · Next.js · Neon Postgres)
   ├─ /portal ............ müşteri arayüzü (magic-link girişi)
   ├─ /api/portal/* ...... yükleme, kuyruk, ayarlar
   ├─ /api/queue/caption . caption üretimi (QStash tetikler)
   ├─ /api/queue/tick .... slot kontrolü + yayın (QStash, 5 dk)
   └─ publishApprovedPost  mevcut iki fazlı Reels yayını (değişmez)
        │                    │                   │
        ▼                    ▼                   ▼
  Cloudflare R2        fal.ai Whisper      Claude (caption)
  (videolar, kareler)  (transkript)        Instagram Graph API
```

### Neden ayrı sunucu (worker) yok

Video işlenmediği için ffmpeg gerekmiyor; geriye kalan her iş (imzalı URL
üretmek, dış API çağırmak, yayın) Vercel fonksiyonunun 60 sn sınırına sığıyor.
Onay, yayın, token yenileme, e-posta ve IDOR/CSRF kalıpları bu repoda zaten
var ve test ediliyor; yeniden yazılmıyor.

### Neden QStash

Vercel Hobby cron'u günde bire sınırlı ve ±59 dk oynuyor (bkz. `CLAUDE.md`
Tuzaklar). "19:00'da yayınla" için yetmez. Upstash QStash:

- her **5 dakikada** `POST /api/queue/tick` çağırır (günde 288 mesaj),
- her yüklenen video için bir kez `POST /api/queue/caption/[postId]` çağırır
  ve başarısız isteği kendisi tekrar dener.

İstekler QStash imzasıyla (`@upstash/qstash` `Receiver`) doğrulanır; imzasız
istek 401. Mevcut günlük Vercel cron'ları güvenlik ağı olarak kalır. Yedek
tetikleyici: cron-job.org + `CRON_SECRET`.

Kota V1'de ölçülür; sonuç `KARARLAR.md`'ye yazılır.

### Neden R2 ve imzalı URL

- 10 GB ücretsiz depolama, **dışarı aktarım ücretsiz** — video hem portalda
  izleniyor hem Instagram ve fal tarafından indiriliyor.
- **Bucket gizli.** Public erişim açılmaz; her erişim süreli imzalı URL ile:
  - yükleme: `PUT`, 15 dk;
  - okuma: `GET`, 1 saat – 7 gün (portal oynatıcı, fal Whisper, Claude'a
    giden kareler, Instagram konteyneri).
- Özel alan adı ya da hız sınırlı `r2.dev` gerekmez. Instagram'ın imzalı
  URL'den video çekebildiği **V1'de doğrulanacak**; çekemezse Cloudflare'e
  bir alt alan adı bağlanır.
- Mevcut ajans/furi akışı **Vercel Blob'da kalır**, ona dokunulmaz.

Anahtar düzeni: `clients/<clientId>/videos/<postId>.<ext>` ve
`clients/<clientId>/frames/<postId>/<n>.jpg`. İmzalı URL yalnızca kapsam
(`clientId`) doğrulandıktan sonra üretilir.

Kod: `src/lib/storage-r2.ts` (`@aws-sdk/client-s3` +
`@aws-sdk/s3-request-presigner`). Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET` — anahtar yalnızca bu bucket'a yetkili.
Bucket CORS'u portal alan adına ve `localhost`a `PUT` izni verir.

Env boşken davranış mevcut desene uyar (`CLAUDE.md`: "sistem çalışmaya devam
eder, ama sessizce değil"): R2 yoksa portal yüklemesi açık bir hatayla kapalı
olur; çekirdek onay akışı etkilenmez.

## 3. Caption üretimi

Video işlenmediği için her şey dış servislerle ve tarayıcıda yapılır:

1. **Transkript** — fal.ai `fal-ai/whisper` (subtitle-pipeline'ın kullandığı
   model). Videonun R2 imzalı `GET` URL'i doğrudan `audio_url` olarak verilir.
   fal'ın mp4 kabul ettiği **V1'de doğrulanacak.**
   *Not:* `fal-ai/wizper` kullanma — tek dev parça döndürüyor (subpipe'ta
   yaşandı).
2. **Görsel bağlam** — konuşmasız videolar var (kâğıda yazı yazılan
   videolar gibi). Tarayıcı yükleme sırasında `<video>` + `canvas` ile
   **6 kare** çıkarır, JPEG olarak R2'ye koyar. Sunucuda ffmpeg yok.
3. **Claude** — kareler + transkript + `Client.captionStyle` gönderilir,
   yapılandırılmış çıktı istenir: `aciklama`, `hashtagler[]`, `altText`.
   - Model: `claude-sonnet-5` (maliyet; bu iş için yeterli). Uygulamadan önce
     `claude-api` skill'i okunur.
   - Kural: **videoda geçmeyen bilgi uydurulmaz.**
4. **Kod tarafında doğrulama** — toplam ≤ 2000 karakter (SaaS'ın mevcut
   sınırı), 10–15 hashtag, boş alan yok. Geçmezse bir kez yeniden üretilir;
   yine geçmezse `captionStatus = failed`, portalda "yeniden üret" butonu.
5. **Yeniden üretme** — kullanıcı isteğe bağlı bir not yazabilir ("daha kısa
   olsun"); transkript ve kareler yeniden kullanılır, yalnızca Claude çağrılır.

## 4. Veri modeli

Göç `nextjs-prisma:goc` ile yapılır. Taslak — kesin hali V1'de netleşir.

**`Post`** (genişler; yayın mantığı aynen kullanılır):

| Alan | Tip | Neden |
|---|---|---|
| `source` | `agency \| portal` | Portal postu onaylanınca anında yayınlanmaz, kuyrukta kalır |
| `queuePosition` | Float? | Sıralama; araya taşıma iki komşunun ortalaması (tek satır güncellenir) |
| `captionStatus` | `pending \| generating \| ready \| failed` | Hazır olmayan video yayına seçilmez |
| `transcript` | Text? | Yeniden üretmede Whisper tekrar çağrılmasın |
| `frameKeys` | String[] | R2 anahtarları (URL değil — URL süreli) |
| `videoKey` | String? | R2 anahtarı; `videoUrl` Blob akışında kalır |
| `slotAt` | DateTime? | Hangi slotta yayınlandı |

**`PublishSettings`** (Client başına bir satır):

| Alan | Varsayılan | Not |
|---|---|---|
| `slots` | `["19:00"]` | Günlük yayın sayısı = slot sayısı |
| `timezone` | `Europe/Istanbul` | |
| `requireApproval` | `true` | Güvenli varsayılan |
| `paused` | `false` | |
| `notifyEmail` | Client.email | Yayın sonucu e-postalarının adresi |

**`SlotRun`** — `(clientId, slotAt)` UNIQUE, `postId?`, `outcome`
(`published | failed | empty | skipped`). Aynı slotun iki kez yayın
yapmasını engelleyen idempotency kaydı; iki tick yarışırsa yalnızca INSERT'i
başaran devam eder.

**`ClientUser` + `ClientLoginToken`** — müşteri girişi (magic link, Resend).
Bugün müşterinin girişi yok; yalnızca post başına onay linki var.

**`Client.captionStyle`** (Text) — müşteriye özel caption talimatı.

## 5. Kuyruk ve yayın kuralları

Saf fonksiyonlar `src/lib/queue.ts`'te; DB'siz birim test edilir.

- **`dueSlots(settings, now, runs)`** — saati geçmiş ama `SlotRun` kaydı
  olmayan slotları döner. **Pencere 1 saat:** daha eski kaçırılmış slot yayın
  yapmaz, `skipped` yazılır. Sistem bir gün kapalı kalırsa ertesi gün birikmiş
  videoları art arda yayınlamasın diye.
- **`pickNext(queue, requireApproval)`** — `queuePosition` sırasında ilk
  uygun video. Uygunluk:
  - `captionStatus = ready`,
  - yayınlanmamış, reddedilmemiş, kuyruktan çıkarılmamış,
  - `requireApproval` açıksa `status = approved`.

  Onay açıkken sıradaki video onaysızsa **sıradaki ilk onaylı video**
  yayınlanır. Hiç yoksa yayın olmaz, `empty` yazılır ve e-posta gider.
- **Tick akışı** (`/api/queue/tick`), her müşteri için:
  1. `paused` ise geç.
  2. Vadesi gelen slotu bul; `SlotRun` INSERT et — UNIQUE çakışması = başka
     tick almış, geç.
  3. `pickNext` ile video seç.
  4. Onay kapalıysa `status = approved` + `ApprovalAudit(action: 'auto_approved')`.
  5. `publishApprovedPost` çağır (mevcut, hiç throw etmez, kendi kilidi var).
  6. Reels konteyneri hazır değilse sonraki tick'ler mevcut `resumePublish`
     ile tamamlar — bugün bunu günlük cron'un "takılı kalan" dalı yapıyor.
- **Hata** — video "hata" rozetiyle kuyruğun başında kalır; portaldan "tekrar
  dene" ya da "sona at". Bir sonraki slotta sıradaki video yayınlanır; tek
  hata kuyruğu durdurmaz.

### Güvenlik kuralı (değişmez)

**`requireApproval = true` iken onaysız video hiçbir yoldan yayınlanmaz.**
Kontrol iki yerde: `pickNext` içinde ve yayın kilidi alınmadan hemen önce.
İkisi de ayrı testle sınanır.

Portal route'ları `CLAUDE.md`'deki sabit kontrol sırasını izler; müşteri
oturumu için `getScopedDb`'nin **müşteri kapsamlı** bir varyantı eklenir —
A müşterisi B'nin kuyruğunu göremez, taşıyamaz, imzalı URL'sini alamaz.

## 6. E-postalar

Hepsi `gonder()` / `notifyAgencyTeam()` üzerinden (bkz. `CLAUDE.md`).

| Olay | Alıcı | İçerik |
|---|---|---|
| Yayın başarılı | müşteri | `igPermalink`, caption'ın başı |
| Yayın başarısız | müşteri + ajans ekibi | hata nedeni (sır içermez), portal linki |
| Slot boş kaldı (onay açık, onaylı video yok) | müşteri | "Bu saatte yayınlanacak onaylı video yoktu" |
| Günlük özet (onay açık) | müşteri | "N video onay bekliyor" — her video için ayrı mail yok |
| Günlük hatırlatma (her iki mod) | müşteri | "Yarın 19:00'da şu video yayınlanacak" + kapak karesi |

Hatırlatma onay kapalıyken de gider: kullanıcı ne yayınlanacağını önceden
görsün ve isterse sırayı değiştirsin.

## 7. Portal ekranları (`/portal`)

- **Yükle** — çoklu dosya seçimi:
  1. `POST /api/portal/upload` her dosya için taslak Post + R2 imzalı `PUT`
     URL'i döner.
  2. Tarayıcı dosyayı doğrudan R2'ye yükler (Vercel'in 4.5 MB gövde sınırı
     yok), ilerleme çubuğu gösterir; 6 kareyi çıkarıp onları da yükler.
  3. `POST /api/portal/videos/[id]/complete` `HeadObject` ile dosyanın
     gerçekten yüklendiğini ve boyutunu doğrular, Post'u kuyruğun sonuna
     ekler, caption mesajını QStash'e yollar.

  Sınırlar mevcut kodla aynı: 300 MB (`MAX_VIDEO_BYTES`), ≤ 90 sn, dikey.
- **Kuyruk** — kart başına kapak karesi, caption'ın başı, durum rozeti
  (caption hazırlanıyor / onay bekliyor / onaylı / hata) ve tahmini yayın
  zamanı (sıra + slotlardan hesaplanan gösterim). Sürükle-bırak (`@dnd-kit`);
  mobilde yukarı/aşağı okları.
- **Video detayı** — oynatıcı, düzenlenebilir caption, "yeniden üret" (not
  ile), Onayla / Reddet / Kuyruktan çıkar.
- **Geçmiş** — yayınlananlar (Instagram linkiyle) ve başarısızlar.
- **Ayarlar** — yayın saatleri, onay aç/kapat (kapatırken uyarı), duraklat,
  bildirim e-postası.

Ajans paneli (`/dashboard`) aynı kuyruğu müşteri seçerek görür.

## 8. Mevcut koda dokunuşlar

- `src/lib/publish-post.ts` — onay koruması, `slotAt` yazımı.
- `src/app/api/approve/[token]/route.ts` — `source = portal` ise onay
  anında yayın tetiklemez; post kuyrukta kalır.
- `src/app/api/cron/publish-scheduled` — dokunulmaz; güvenlik ağı olarak kalır.
- furi1 — Reels için elle `saas_gonder.py` yolu emekliye ayrılır (furi1
  belgelerine not). Karusel akışına dokunulmaz.

## 9. Maliyet

| Kalem | Ücret |
|---|---|
| Vercel Hobby, Neon, Upstash (Redis + QStash), R2 | ücretsiz katman |
| fal Whisper | video başına birkaç sent |
| Claude Sonnet 5 (caption + yeniden üretim) | video başına birkaç sent |

Ücretsiz katman sınırları V1'de ölçülüp `KARARLAR.md`'ye yazılır.
