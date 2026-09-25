# V7 — Portalı telefonda uygulama gibi kullanma (PWA)

> **Durum: ⬜ planlandı, uygulanmadı.** Kullanıcı başlatana kadar kod yazılmaz.
> Karar: [K23](KARARLAR.md). Faz durumu: [`FAZLAR.md`](FAZLAR.md).
> İlgili: [V6 — kare kırpma](V6-kare-kirpma.md).

## 1. Neden

Sayfa sahibi videoları telefonla çekiyor; yüklemeyi de telefondan yapacak.
Portal bugün yalnızca bir web sayfası: her seferinde tarayıcı açıp adres
yazmak gerekiyor. Hedef: portal **ana ekrandan açılan, tam ekran çalışan**
bir uygulama gibi davransın ve galeriden video yüklemek kolay olsun.

## 2. Bugünkü durum (2026-09-25, ölçüldü)

- Web app manifest **yok**, ikon **yok**, service worker **yok**.
- `src/app/layout.tsx` yalnızca `metadata` export ediyor; `viewport` /
  `themeColor` / `appleWebApp` ayarı yok.
- `public/` altında yalnızca `uploads/` var.
- CSP (`next.config.ts`): `worker-src` ve `manifest-src` tanımsız — ikisi de
  `default-src 'self'` / `script-src 'self'`'e düşer; aynı kaynaktan
  servis edilen manifest ve worker izinli.

## 3. Yapılacaklar

### 3.1 Kurulabilirlik
- **Manifest:** `src/app/manifest.ts` (Next.js `MetadataRoute.Manifest`):
  - `name` / `short_name` (ör. "Video Kuyruğu" / "Kuyruk" — kullanıcıya sor)
  - `start_url: "/portal"`, `scope: "/portal"`, `display: "standalone"`
  - `theme_color`, `background_color` (portal renkleriyle)
  - `icons`: 192, 512 ve `purpose: "maskable"` 512 (PNG, `public/icons/`)
- **iOS:** `apple-touch-icon` (180 px); `metadata.appleWebApp`
  (`capable: true`, `statusBarStyle`, `title`).
- **Viewport:** `export const viewport` → `width=device-width`,
  `initialScale: 1`, `viewportFit: "cover"`, `themeColor`. Portal CSS'ine
  güvenli alan boşlukları (`env(safe-area-inset-*)`) — çentikli ekranlar ve
  alttaki gezinme çubuğu.

### 3.2 Service worker (en küçüğü)
- `public/sw.js`, kapsam `/portal`; `/portal` layout'unda
  `navigator.serviceWorker.register` (yalnızca production).
- **Önbellek kuralı (değişmez):** API (`/api/**`), R2 imzalı URL'ler ve
  oturumlu HTML yanıtları **asla önbelleğe alınmaz**. Yalnızca statik kabuk
  (`/_next/static/**`, ikonlar) ve tek bir çevrimdışı sayfa
  ("Bağlantı yok, tekrar dene").
  Neden: oturum başka kullanıcıya ya da bayat kuyruk durumuna sızmasın;
  imzalı URL'lerin süresi zaten doluyor.
- Güncelleme: yeni sürümde `skipWaiting` + sayfada "Yeni sürüm var, yenile"
  bildirimi (sessiz eski sürümde kalmasın).
- `src/lib/csp.test.ts`'e: worker'ın aynı kaynaktan geldiğini ve `blob:`
  worker'a izin verilmediğini doğrulayan assertion.

### 3.3 Giriş sorunu — KRİTİK
**iOS'ta ana ekrana eklenen PWA'nın çerez deposu Safari'den ayrı.** Kullanıcı
Mail'deki giriş linkine dokunduğunda link Safari'de açılır; oturum Safari'de
kurulur, PWA'da açılmaz. Mevcut magic link akışı (K19: link GET'te
harcanmıyor, sayfadaki buton POST'la tüketiyor) bu sorunu çözmüyor.

**Çözüm: e-postada linkin yanında 6 haneli giriş kodu.**
- PWA giriş ekranında "E-postana gelen kodu gir" alanı.
- Kod: tek kullanımlık, 15 dk, **yalnızca hash'i** saklanır (token deseniyle
  aynı), karşılaştırma sabit zamanlı.
- Deneme sınırı: kullanıcı başına ve IP başına (`checkRateLimit`); 6 hane =
  10⁶ olasılık, sınır olmadan kaba kuvvete açık. Ör. kod başına 5 hatalı
  deneme → kod geçersiz.
- Şema: `ClientLoginToken`'a `codeHash` kolonu mu, ayrı satır mı — V7'de
  karar (`nextjs-prisma:goc` ile).
- Link akışı aynen kalır (masaüstü ve Android tarayıcı için).
- Android'de de işe yarar (Chrome'da PWA çerezleri paylaşılıyor ama kod yolu
  her yerde aynı deneyimi verir).

### 3.4 Paylaşım hedefi (Android, isteğe bağlı)
- Manifestte `share_target` (`method: "POST"`, `enctype:
  "multipart/form-data"`, `files: [{ name: "video", accept: ["video/*"] }]`).
- Galeride "Paylaş → portal" → yükleme ekranı dosyayla açılır. Dosya
  service worker'da yakalanıp sayfaya aktarılır (sunucuya büyük gövde
  gönderilmez — Vercel 4.5 MB sınırı).
- iOS `share_target` desteklemiyor; orada dosya seçici yeterli.

### 3.5 Mobil kullanılabilirlik denetimi
- Dokunma hedefleri ≥ 44 px; kuyrukta sürükle-bırak yerine yukarı/aşağı
  okları (V3'te var) mobilde öne çıksın.
- Dosya seçici `accept="video/*"` (galeri + kamera seçenekleri).
- Yükleme sürerken `beforeunload` uyarısı; V6'daki wakeLock.
- Yavaş ağda ilerleme çubuğu ve hata sonrası "tekrar dene".

### 3.6 Kapsam dışı (açık soru)
- **Web Push** (iOS 16.4+ yüklü PWA'da çalışıyor): "yayınlandı", "onay
  bekliyor", "slot boş" bildirimleri e-postanın yanına. Abonelik tablosu ve
  VAPID anahtarı gerekir → ayrı faz.

## 4. Doğrulama
1. Lighthouse (mobil) yüklenebilirlik denetimi — manifest, ikon, SW.
2. iPhone Safari: "Ana Ekrana Ekle" → PWA açılır → **kod ile giriş** →
   yükleme → kuyruk → video detayı. Çentik/alt çubuk boşlukları.
3. Android Chrome: "Uygulamayı yükle" → giriş → galeriden paylaşım hedefi.
4. Uçak modu: çevrimdışı sayfası görünür; tekrar çevrimiçi → normal akış.
5. DevTools → Application → Cache Storage: `/api/**` ve HTML yanıtı YOK.
6. Kod girişi testleri (Vitest): tek kullanım, süre dolumu, hash saklama,
   deneme sınırı, yanlış kod sabit zamanlı red, enumeration yok.

## 5. V6 ile sıra
İkisi bağımsız. **Öneri: önce V7, sonra V6** — kırpma telefonda
denenecek; kurulu PWA ve kodla giriş bu testleri kolaylaştırır. Sıra
kullanıcıya sorulacak.
