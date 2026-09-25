"use client";

import { useEffect } from "react";

/**
 * V7a — portal service worker'ının kaydı (V7-pwa §4.6). Görünmez.
 *
 * Yalnızca production'da: dev sunucusunda SW, HMR'nin yeniden yüklediği
 * sayfaları kontrol altına alıp "neden değişikliğim görünmüyor" sınıfı
 * hataları doğurur. `process.env.NODE_ENV` build'de sabite dönüşür, dev
 * paketinde kayıt kodu hiç çalışmaz.
 *
 * Dosya kökte (`/sw.js`) ama kapsam "/portal": ajans paneli ve onay sayfası
 * hiçbir zaman SW kontrolüne girmez. Kapsam neden "/portal/" değil: SW kapsamı
 * düz önek eşleşmesi; "/portal/" kapsamı "/portal" açılış sayfasını
 * KAPSAMAZDI ve çevrimdışı yedek tam da en çok açılan sayfada çalışmazdı
 * (manifest `scope`'uyla aynı gerekçe — bkz. `portal-app.ts`).
 *
 * ─── Güncelleme ────────────────────────────────────────────────────────────
 * Yeni SW kurulup `waiting`e düşünce sayfaya `SW_UPDATE_EVENT` yayınlanır;
 * görsel bant (V7-pwa §4.6 "Yeni sürüm hazır — yenile") onu dinleyip
 * dokunulunca `applyServiceWorkerUpdate()` çağırır. `skipWaiting` KENDİLİĞİNDEN
 * yapılmaz: yükleme sürerken sayfanın altından SW değişmesin.
 */

export const SW_URL = "/sw.js";
export const SW_SCOPE = "/portal";
/** `window`'a yayınlanan olay; `detail` yok — bekleyen SW `registration.waiting`'de. */
export const SW_UPDATE_EVENT = "portal:sw-guncelleme";

let waitingWorker: ServiceWorker | null = null;

function announce(worker: ServiceWorker) {
  waitingWorker = worker;
  window.dispatchEvent(new Event(SW_UPDATE_EVENT));
}

/** Bant "yenile"ye dokununca: bekleyen SW'ye izin ver, devralınca sayfayı yenile. */
export function applyServiceWorkerUpdate(): boolean {
  if (!waitingWorker || !("serviceWorker" in navigator)) return false;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Birden fazla controllerchange gelirse sonsuz yenileme döngüsüne girme.
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
  return true;
}

/** Bant yeniden takıldığında (ör. sayfa değişimi) bekleyen sürüm var mı? */
export function hasWaitingServiceWorker(): boolean {
  return waitingWorker !== null;
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    navigator.serviceWorker
      .register(SW_URL, { scope: SW_SCOPE })
      .then((registration) => {
        if (cancelled) return;
        // Önceki ziyarette kurulup bekleyen sürüm.
        if (registration.waiting && navigator.serviceWorker.controller) {
          announce(registration.waiting);
        }
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // `controller` yoksa bu İLK kurulum: güncelleme değil, bant gereksiz.
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              announce(installing);
            }
          });
        });
      })
      .catch((error) => {
        // Kayıt başarısızlığı portalı etkilemez; yalnızca çevrimdışı yedek yok.
        console.warn("[sw] kayıt başarısız", (error as Error).message);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
