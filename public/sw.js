/*
 * Video kuyruğu — portal service worker'ı (V7a, docs/video-kuyrugu/V7-pwa.md §4.6).
 *
 * Kapsam "/portal" (kayıt: src/components/portal/sw-register.tsx). Dosya kökte
 * duruyor ki kapsam daraltılabilsin; ajans paneli ve onay sayfası hiçbir zaman
 * bu worker'ın kontrolüne girmez.
 *
 * ─── ÖNBELLEK KURALI (DEĞİŞMEZ) ──────────────────────────────────────────────
 * Önbelleğe YALNIZCA şunlar girer:
 *   • /portal/cevrimdisi — statik, oturumsuz çevrimdışı sayfası,
 *   • /icons/**          — herkese açık ikon PNG'leri.
 * ASLA önbelleğe alınmaz: /api/**, R2 (imzalı URL'ler — başka origin),
 * portal HTML'i (oturumlu sayfalar), /_next/** dahil diğer her şey.
 * Neden: bayat kuyruk durumu ya da bir başkasının oturumlu sayfası
 * gösterilmesin; imzalı URL'lerin süresi zaten doluyor. Bu listeye bir şey
 * eklemeden önce "bu yanıt kişiye özel mi?" sorusunu sor.
 *
 * Navigasyon → her zaman ağ; ağ yoksa çevrimdışı sayfası. Yanıt önbelleğe
 * YAZILMAZ.
 *
 * ─── Güncelleme ─────────────────────────────────────────────────────────────
 * `skipWaiting` yalnızca sayfa {type: "SKIP_WAITING"} gönderince (kullanıcı
 * "yenile"ye dokununca). Kendiliğinden devralmak, yükleme sürerken sayfanın
 * altından worker'ı değiştirirdi. Önbellek içeriği değiştiğinde SURUM artırılır;
 * eski önbellekler `activate`te silinir.
 *
 * ─── İLERİDE EKLENECEK (şimdi YOK) ─────────────────────────────────────────
 *   • V7c: `push` → showNotification, `notificationclick` → ilgili portal
 *     sayfasını aç/odakla. Aşağıdaki "Olay dinleyicileri" bölümüne ayrı
 *     dinleyiciler olarak.
 *   • V7d: manifest `share_target` POST'u (/portal/paylas). `fetch`
 *     dinleyicisinde GET dışı istekler bugün hiç ele alınmıyor; paylaşım
 *     POST'u oraya, `handleShareTarget(event)` gibi ayrı bir dala girecek.
 *     Dosya Vercel'e gitmez (4.5 MB gövde sınırı) — SW yakalar, geçici
 *     depoya koyar, /portal/yukle'ye yönlendirir.
 */

const SURUM = "v1";
const ONBELLEK_ONEKI = "portal-kabuk-";
const ONBELLEK = ONBELLEK_ONEKI + SURUM;
const CEVRIMDISI_URL = "/portal/cevrimdisi";

// Kurulumda indirilenler. Müşteriye özel ikon setleri (/icons/<müşteri>/)
// burada değil: ilk kullanımda `ikonYaniti` önbelleğe alır.
const ONCEDEN_YUKLE = [
  CEVRIMDISI_URL,
  "/icons/varsayilan/icon-192.png",
  "/icons/varsayilan/icon-512.png",
];

// ─── Yaşam döngüsü ──────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(ONBELLEK).then((cache) =>
      Promise.all(
        ONCEDEN_YUKLE.map((url) =>
          // `credentials: "omit"`: çevrimdışı sayfası çerezsiz istenir; oturumlu
          // bir kopyanın (layout'un müşteri adıyla bastığı başlıklar) önbelleğe
          // girmesi mümkün olmasın.
          fetch(new Request(url, { credentials: "omit", cache: "reload" })).then((res) => {
            if (!res.ok) throw new Error(`${url} → ${res.status}`);
            return cache.put(url, res);
          })
        )
      )
    )
  );
  // skipWaiting YOK — bkz. dosya başı "Güncelleme".
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(ONBELLEK_ONEKI) && key !== ONBELLEK)
            .map((key) => caches.delete(key))
        )
      )
      // İlk kurulumda açık sayfa da hemen kontrol altına girsin: çevrimdışı
      // yedek ikinci ziyareti beklemesin. Güncellemede zaten SKIP_WAITING ile
      // gelindiği için sayfa yenilenecek.
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// ─── İstekler ───────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // GET dışı hiçbir şeye dokunulmaz (mutasyonlar, yükleme). V7d'nin
  // share_target POST'u buraya ayrı bir dal olarak eklenecek.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Başka origin (R2 imzalı URL'ler, Blob görselleri): tarayıcının kendisine
  // bırak. `respondWith` çağrılmayan istek SW yokmuş gibi ağa gider.
  if (url.origin !== self.location.origin) return;

  // /api/** — ne önbellek ne yedek; hata olduğu gibi sayfaya ulaşsın.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(navigasyonYaniti(request));
    return;
  }

  if (url.pathname.startsWith("/icons/")) {
    event.respondWith(ikonYaniti(request));
    return;
  }

  // Geri kalan her şey (/_next/**, manifest, sw.js): varsayılan ağ yolu.
});

/** Ağ önce; ağ yoksa çevrimdışı sayfası. Yanıt önbelleğe YAZILMAZ. */
async function navigasyonYaniti(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(CEVRIMDISI_URL);
    return (
      cached ||
      new Response("İnternet bağlantısı yok.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

/**
 * İkonlar herkese açık ve içerikleri adla birlikte değişir (yeni set = yeni
 * klasör), bu yüzden önbellek önce. Yalnızca başarılı ve aynı-origin
 * ("basic") yanıtlar yazılır.
 */
async function ikonYaniti(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") {
    const copy = res.clone();
    caches.open(ONBELLEK).then((cache) => cache.put(request, copy));
  }
  return res;
}
