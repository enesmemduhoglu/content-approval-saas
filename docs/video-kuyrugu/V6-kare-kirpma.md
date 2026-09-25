# V6 — Yüklemede 1:1 (kare) kırpma

> **Durum: ⬜ planlandı, uygulanmadı.** Kullanıcı başlatana kadar kod yazılmaz.
> Karar: [K22](KARARLAR.md). Faz durumu: [`FAZLAR.md`](FAZLAR.md).
> Plan yazılırken master: `0ec916f` sonrası (#58 dahil). Aşağıdaki satır
> numaraları o duruma göre; uygulamadan önce yeniden doğrula.

## 1. Neden

@furkanteacherteaching videolarını **dikey çekiyor, 1:1 kare yayınlıyor.**
Kare kırpma çekimi kolaylaştırıyor: etraf dağınık olsa da, kamera açısı tam
olmasa da yalnızca kadraja giren kısım yayınlanıyor.

V0–V5 videoyu hiç işlemeden yayınlıyor (K1). 2026-09-25 03:10'daki ilk
canlı yayın bu yüzden dikey çıktı. Hedef: yükleme sırasında video 1:1
kırpılsın ve yayına kırpılmış hali gitsin.

## 2. Kullanıcı kararları (2026-09-25)

| Soru | Karar |
|---|---|
| Son görünüm | **Yalnızca kare video.** Zemin, yazı, renk dolgusu yok. |
| Çerçevenin yeri | **Varsayılan orta**, önizlemede parmakla/fareyle kaydırılabilir. Dokunulmazsa orta kullanılır. |
| Her video mu? | **Video başına seçim:** "Kare (1:1) / Orijinal", varsayılan **Kare**. |

## 3. Yaklaşım: kırpma kullanıcının tarayıcısında

Kırpma yüklemeden ÖNCE, kullanıcının cihazında yapılır; R2'ye kırpılmış MP4
gider. Sonrası (kareler, caption, kuyruk, yayın) hiç değişmez.

**Neden tarayıcı:**
- Ücretsiz, sunucu yok. Vercel fonksiyonunun 60 sn sınırı ve ffmpeg
  paketlemesi sorunları hiç doğmuyor. K2'deki "ayrı sunucu yok" kararı
  bozulmuyor.
- Telefon ve bilgisayarlarda donanım kodlayıcı var (WebCodecs). 1080p,
  ≤ 90 sn bir video için süre saniyeler – on saniyeler mertebesinde.
- Alternatifler ve neden seçilmediği:
  - Vercel'de ffmpeg: 60 sn sınırına takılabilir, bellek sınırı var.
  - fal.ai ffmpeg servisi: video başına ücretli.
  - Worker (Oracle vb.): K2 ile reddedildi.

**Kütüphane: [Mediabunny](https://mediabunny.dev)** (saf TypeScript, bağımlılığı
yok, WebCodecs üzerine). Kullanılacak API:

```ts
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input,
         Mp4OutputFormat, Output, QUALITY_HIGH } from "mediabunny";

const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
const output = new Output({
  format: new Mp4OutputFormat({ fastStart: "in-memory" }), // moov başta
  target: new BufferTarget(),
});
const conversion = await Conversion.init({
  input, output,
  video: { crop: rect, width: out, height: out, codec: "avc",
           bitrate: QUALITY_HIGH, forceTranscode: true },
  audio: { codec: "aac" },          // AAC ise kopyalanır, değilse dönüştürülür
});
if (!conversion.isValid) { /* conversion.discardedTracks → CropError */ }
conversion.onProgress = (p) => setProgress(p); // 0..1
await conversion.execute();
const blob = new Blob([output.target.buffer!], { type: "video/mp4" });
```

> `crop` seçeneğinin tam alan adları (`left/top/width/height`) ve rotasyonla
> ilişkisi uygulamadan önce güncel belgeden doğrulanmalı.

**CSP değişmez.** İşlem ana iş parçacığında, WebAssembly yok. `connect-src`
ve `media-src` (`blob:`) zaten yeterli. Worker gerekirse aynı kaynaktan
servis edilmeli (`worker-src` tanımsız → `script-src 'self'`e düşer).

**Instagram:** Reels için izin verilen oran 0.01:1 – 10:1, önerilen 9:16.
1:1 izinli ama **uygulamada yayınsız container testiyle doğrulanacak**
(K21'deki yöntem: container aç, `FINISHED` bekle, `media_publish` çağırma).

## 4. Dosya dosya değişiklikler

### 4.1 `src/lib/crop-client.ts` (yeni, yalnızca tarayıcı)
- `squareCropRect(width, height, offset = 0.5)` — **saf fonksiyon**:
  - `side = min(w, h)`; uzun eksende `start = round((long - side) * offset)`.
  - Dikey: `{ left: 0, top: start, width: side, height: side }`;
    yatay: `left` kayar.
  - Tüm değerler **çift sayıya** yuvarlanır (H.264 4:2:0 şartı).
  - Zaten kare ise `null` (kırpma gereksiz).
- `canCropInBrowser()` — `VideoEncoder` / `VideoDecoder` var mı.
- `cropToSquare(file, offset, onProgress): Promise<Blob>`:
  - Yukarıdaki API. Çıktı kenarı `out = min(side, 1080)`.
  - Video izi `discardedTracks` içindeyse ya da çıktı süresi girdiden
    belirgin farklıysa `CropError` (Türkçe, kullanıcıya gösterilebilir).
- **Rotasyon:** iPhone `.mov` dosyaları döndürme üst verisiyle kaydediliyor.
  Crop'un GÖRÜNTÜLENEN kareye (kullanıcının önizlemede gördüğüne) uygulandığı
  gerçek bir iPhone dosyasıyla doğrulanmalı; değilse koordinatlar döndürülür
  ya da `rotate` kullanılır. **En büyük açık risk bu.**

### 4.2 `src/components/portal/crop-picker.tsx` (yeni)
- Seçilen dosyanın `<video>` önizlemesi (object URL, muted, playsInline).
- Üstünde kare çerçeve; dışarıda kalan alan yarı saydam karartılır.
- Çerçeve uzun eksende **pointer olaylarıyla** sürüklenir (fare + dokunmatik);
  `offset` 0..1. Klavye erişimi için ok tuşları.
- Üstte "Kare (1:1) / Orijinal" seçici (varsayılan Kare).
- Video açılamıyorsa (bazı HEVC `.mov`, bkz. `frames-client.ts` →
  `extractFrames` `probe: null`) bileşen gizlenir, mod "Orijinal"e düşer ve
  kısa bir not gösterilir.

### 4.3 `src/components/portal/upload-form.tsx` (değişir)
- `ItemState` (L8-16): `mode: "kare" | "orijinal"` (varsayılan kare),
  `offset: number` (0.5), `cropProgress`. `onPick` (L71-88) sırasında mevcut
  `extractFrames` probe'u ölçü için kullanılır ve her kalemin altında
  `CropPicker` açılır.
- `PHASE_LABEL` (L20-27): yeni aşama `kırpılıyor` (yüzdeyle).
- `start()` (L90-161), "frames" döngüsü (L96-111):
  1. Kare modundaysa `cropToSquare(file, offset)` → `file` yerine çıktı
     Blob'u.
  2. **Kareler kırpılmış Blob'dan** çıkarılır — caption yayınlanacak
     görüntüyü görsün.
  3. Kırpma başarısızsa kalem `hata` olur ve **"Orijinal olarak yükle"**
     butonu çıkar. Sessizce orijinale düşülmez: kullanıcı ne yayınlanacağını
     bilmeli.
- Dosyalar **sırayla** işlenir (bellek: çıktı `BufferTarget`'ta tutuluyor;
  60 sn × ~8 Mbps ≈ 60 MB). Mevcut akış zaten sıralı.
- `POST /api/portal/upload` gövdesi (L115-128) ve PUT (L135) çıktının
  tipini (`video/mp4`) ve boyutunu kullanır. `videoType()` (L37-43) Blob'un
  `type`'ını okur. Sonuç: bir `.mov` artık `.mp4` anahtarıyla saklanır.
- `navigator.wakeLock.request("screen")` — işlem sürerken ekran kararmasın;
  desteklenmiyorsa atlanır. İşlem sürerken `beforeunload` uyarısı.

### 4.4 Diğer küçük değişiklikler
- `src/lib/frames-client.ts` `probeError` (L108-117): kare modunda yatay
  videoya izin (kırpılınca kare olur). Fonksiyona `mode` parametresi.
- Metinler:
  - `src/app/portal/yukle/page.tsx` L16-18 "Videolara hiçbir işlem yapılmaz"
    → "Video istersen 1:1 kırpılır; başka işlem yapılmaz."
  - `upload-form.tsx` L168 etiketteki "dikey" kaldırılır.
- Kapak önizlemeleri 9:16'ya sabit; kare kapak kırpılmasın diye
  `object-fit: contain`:
  - `src/app/portal/portal.css` L112
  - `src/app/globals.css` L442
  - `src/lib/email-queue.ts` L277 (e-posta kapağı 120×213)
- Bağımlılık: `npm install mediabunny`.

### 4.5 Değişmeyenler
- Sunucu route'ları, şema, R2, caption, tick, yayın. `upload`/`complete`
  tip ve boyutu zaten doğruluyor (`validateUploadFiles`, `headObject`);
  sunucu videonun oranına hiç bakmıyor.
- Kırpma bilgisi DB'de tutulmaz — yayınlanan dosya zaten kırpılmış.

## 5. Riskler

| Risk | Ne olur | Önlem |
|---|---|---|
| iPhone rotasyon üst verisi | Çerçeve yanlış eksene uygulanır | Gerçek iPhone `.mov` ile doğrulama (§6.4); gerekirse koordinat dönüşümü |
| WebCodecs yok / HEVC çözülemiyor | Kırpma başlamaz | Kalem hata + "Orijinal olarak yükle"; iOS Safari 16.4+, güncel Chrome destekliyor |
| Uzun video, telefon ısınması | Yavaşlama | ≤ 90 sn sınırı zaten var; ilerleme gösterilir |
| Sekme arka plana alınır | Kodlama yavaşlar/durur | wakeLock + uyarı metni |
| Instagram 1:1 Reels'i farklı gösterir | Beklenmedik kırpma | Yayınsız container testi, sonra tek bir canlı deneme |

## 6. Doğrulama

1. **Birim testi** `src/lib/crop-client.test.ts` — `squareCropRect`:
   1080×1920, 1440×1920, 1920×1080, kare, tek sayılı ölçüler; offset 0 / 0.5
   / 1; sonuç hep çift ve kaynağın içinde.
2. **UI testi** `src/components/portal/upload-form.ui.test.tsx` (jsdom
   pragma'sı) — `@/lib/crop-client` ve `@/lib/frames-client` `vi.mock`
   (kalıp: `queue-board.ui.test.tsx`):
   varsayılan Kare → `cropToSquare(file, 0.5)`; Orijinal → çağrılmaz;
   POST gövdesi `contentType: "video/mp4"` + kırpılmış boyut; kırpma hatası →
   "Orijinal olarak yükle" butonu.
3. `npx tsc --noEmit`, tüm testler (ayrı `TEST_DATABASE_URL`), `npm run build`, CI.
4. **Gerçek cihazlar** (preview ya da prod): PC Chrome (dikey mp4), iPhone
   Safari (HEVC `.mov`, döndürülmüş), Android Chrome; çerçeveyi kaydırarak.
   R2'deki çıktı indirilip `ffprobe` ile: ≤ 1080×1080 kare, h264 + aac, süre
   aynı; bir kare gözle kontrol (doğru bölge).
5. **Instagram yayınsız:** kırpılmış dosya, R2 imzalı URL → Reels container →
   `FINISHED`; `media_publish` çağrılmaz.
6. **Uçtan uca:** slot + onaylı kare video → Instagram'da kare Reels;
   kullanıcı test sonrası siler.

## 7. Uygulanınca güncellenecek belgeler
- `KARARLAR.md`: K1'in "video işlenmez" kısmının üstü çizilir → K22;
  K11 (kareler kırpılmış videodan), K19 (dikeylik kontrolü kare modunda
  kalkar) notları.
- `README.md`: §1 (madde 2), §2 ("Neden ayrı sunucu yok" — tarayıcı
  gerekçesi), §7 (yükleme adımları).
- `FAZLAR.md`: V6 ✅ + oturum devri.
