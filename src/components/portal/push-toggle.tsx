"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { PUSH_API_PATH, PUSH_ENDPOINT_HEADER } from "@/lib/push-shared";
import styles from "./push-toggle.module.css";

/**
 * V7c — "Telefon bildirimleri" satırı (V7-pwa §6.1). Kendi başına çalışır:
 * Ayarlar sayfasına tek satırla (`<PushToggle />`) yerleştirilir, sunucudan
 * prop beklemez — durumu cihazın kendisinden (izin, SW aboneliği) ve
 * `GET /api/portal/push`tan okur.
 *
 * ─── iPhone kuralları (öncelikli cihaz) ────────────────────────────────────
 *  • Web Push yalnızca ANA EKRANA EKLENMİŞ uygulamada var (iOS 16.4+); Safari
 *    sekmesinde `PushManager` hiç yok. O durumda "önce ana ekrana ekle" notu
 *    gösterilir, anahtar pasif.
 *  • İzin yalnızca bir kullanıcı dokunuşunun İÇİNDE istenebilir; bu yüzden
 *    `Notification.requestPermission()` tıklama işleyicisinin İLK await'i —
 *    öncesinde ağ isteği beklenirse iOS dokunuşu "tüketilmiş" sayıp istemi
 *    göstermeyebilir.
 *  • İzin bir kez reddedilince sayfa yeniden soramaz; kullanıcı iPhone
 *    Ayarlar'dan açmalı — not bunu söyler.
 */

type Phase =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "install" }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "ready"; on: boolean; publicKey: string };

/** Servis worker'ın hazır olmasını bu kadar bekler; kayıt yoksa (dev) `ready` hiç çözülmez. */
const SW_READY_TIMEOUT_MS = 5_000;

/** VAPID public anahtarı (base64url) → `applicationServerKey`. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padded = base64url + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ kendini masaüstü Safari (MacIntel) olarak tanıtıyor; dokunmatik
  // nokta sayısı ayırt ediyor.
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

export function PushToggle() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descId = useId();

  const load = useCallback(async () => {
    // Sıra önemli: iOS Safari sekmesinde PushManager YOK, yani "destek yok"
    // demeden önce "ana ekrana ekle" denmeli — çözüm kullanıcının elinde.
    if (typeof window === "undefined") return;
    if (isIos() && !isStandalone()) return setPhase({ kind: "install" });
    if (!pushSupported()) return setPhase({ kind: "unsupported" });
    if (Notification.permission === "denied") return setPhase({ kind: "denied" });

    try {
      const registration = await swRegistration();
      if (!registration) return setPhase({ kind: "unavailable" });
      const subscription = await registration.pushManager.getSubscription();
      const headers: Record<string, string> = {};
      if (subscription) headers[PUSH_ENDPOINT_HEADER] = subscription.endpoint;
      const res = await fetch(PUSH_API_PATH, { headers, cache: "no-store" });
      if (!res.ok) return setPhase({ kind: "unavailable" });
      const data = (await res.json()) as { publicKey: string | null; subscribed: boolean };
      if (!data.publicKey) return setPhase({ kind: "unavailable" });
      // "Açık" = cihazda abonelik VAR ve sunucuda BU kullanıcıya kayıtlı.
      // Cihaz başka kullanıcıdan kalma bir aboneliği taşıyorsa kapalı görünür.
      setPhase({
        kind: "ready",
        on: Boolean(subscription && data.subscribed && Notification.permission === "granted"),
        publicKey: data.publicKey,
      });
    } catch {
      setPhase({ kind: "unavailable" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function enable(publicKey: string) {
    // İLK await izin istemi olmalı (dosya başı: iOS dokunuş kuralı).
    const permission = await Notification.requestPermission();
    if (permission === "denied") {
      setPhase({ kind: "denied" });
      return;
    }
    if (permission !== "granted") {
      setError("Bildirim izni verilmedi.");
      return;
    }
    const registration = await swRegistration();
    if (!registration) {
      setPhase({ kind: "unavailable" });
      return;
    }
    // Cihazda zaten abonelik varsa (ör. önceki kullanıcıdan) yeniden
    // kullanılır: sunucu endpoint'e göre upsert eder ve satırı bu kullanıcıya
    // geçirir. VAPID anahtarı döndürülürse eski abonelik gönderimde hata
    // verir ve `push.ts` 5 hatada siler; kullanıcı anahtarı yeniden açar.
    let subscription = await registration.pushManager.getSubscription();
    const created = !subscription;
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
    }
    const res = await fetch(PUSH_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!res.ok) {
      // Sunucu kaydetmediyse cihazda yetim abonelik bırakma.
      if (created) await subscription.unsubscribe().catch(() => false);
      setError("Bildirimler açılamadı. Biraz sonra tekrar dene.");
      return;
    }
    setPhase({ kind: "ready", on: true, publicKey });
  }

  async function disable(publicKey: string) {
    const registration = await swRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      // Önce sunucu: gönderim hemen dursun. 404 (zaten yok) da kabul.
      const res = await fetch(PUSH_API_PATH, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      if (!res.ok && res.status !== 404) {
        setError("Bildirimler kapatılamadı. Biraz sonra tekrar dene.");
        return;
      }
      await subscription.unsubscribe().catch(() => false);
    }
    setPhase({ kind: "ready", on: false, publicKey });
  }

  async function onToggle() {
    if (phase.kind !== "ready" || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (phase.on) await disable(phase.publicKey);
      else await enable(phase.publicKey);
    } catch {
      setError("Bir sorun oldu. Biraz sonra tekrar dene.");
    } finally {
      setBusy(false);
    }
  }

  const checked = phase.kind === "ready" && phase.on;
  const disabled = phase.kind !== "ready" || busy;

  let note: string | null = null;
  if (phase.kind === "install") note = "Önce ana ekrana ekle (Paylaş → Ana Ekrana Ekle).";
  else if (phase.kind === "denied") note = "Bildirim izni kapalı — iPhone Ayarlar'dan aç.";
  else if (phase.kind === "unsupported") note = "Bu tarayıcı telefon bildirimlerini desteklemiyor.";
  else if (phase.kind === "unavailable") note = "Bildirimler şu an kullanılamıyor.";

  return (
    <div className={styles.row}>
      <div className={styles.text}>
        <p className={styles.title} id={titleId}>
          Telefon bildirimleri
        </p>
        <p className={styles.subtitle} id={descId}>
          Yayınlandı, yayınlanamadı, onay bekleyen videolar.
        </p>
        {note && <p className={styles.note}>{note}</p>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={titleId}
        aria-describedby={descId}
        aria-busy={busy || phase.kind === "loading"}
        disabled={disabled}
        onClick={onToggle}
        className={styles.switch}
      >
        <span className={styles.knob} aria-hidden="true" />
      </button>
    </div>
  );
}
