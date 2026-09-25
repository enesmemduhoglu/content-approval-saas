"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  SW_UPDATE_EVENT,
  applyServiceWorkerUpdate,
  hasWaitingServiceWorker,
} from "@/components/portal/sw-register";

/** Ana ekrandan (uygulama olarak) mı açıldı? iOS eski `navigator.standalone`'ı da tanır. */
export function isStandalone(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
}

/**
 * Ayarlar'ın "Uygulama" bölümü: ikon + kurulum durumu + sürüm, altında çıkış.
 *
 * Durum yalnızca istemcide bilinir (`display-mode`); ilk çizimde nötr metin,
 * effect'te gerçek durum — sunucu HTML'iyle hidrasyon uyuşmazlığı olmasın.
 */
export function AppCard({ appName, iconSrc }: { appName: string; iconSrc: string }) {
  const router = useRouter();
  const [standalone, setStandalone] = useState<boolean | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    setStandalone(isStandalone());
    if (hasWaitingServiceWorker()) setUpdateReady(true);
    const onUpdate = () => setUpdateReady(true);
    window.addEventListener(SW_UPDATE_EVENT, onUpdate);
    return () => window.removeEventListener(SW_UPDATE_EVENT, onUpdate);
  }, []);

  // Portal oturumu NextAuth değil; çıkış kendi route'una POST (eski PortalNav'dan taşındı).
  async function logout() {
    setLeaving(true);
    try {
      await fetch("/api/portal/logout", { method: "POST" });
    } finally {
      router.push("/portal/giris");
      router.refresh();
    }
  }

  const title = standalone === null ? appName : standalone ? "Ana ekrana ekli" : "Ana ekrana ekle";
  const sub = updateReady
    ? "Yeni sürüm hazır"
    : standalone === false
      ? "Safari'de Paylaş → Ana Ekrana Ekle"
      : `${appName} · sürüm güncel`;

  return (
    <section className="p-set" aria-labelledby="ayar-uygulama">
      <h2 className="p-kicker p-kicker--accent" id="ayar-uygulama">
        UYGULAMA
      </h2>
      <div className="p-set-card p-set-card--app">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={iconSrc} alt="" className="p-app-icon" width={40} height={40} />
        <div className="p-set-text">
          <span className="p-set-title">{title}</span>
          <span className="p-set-sub">{sub}</span>
        </div>
        {updateReady && (
          <button
            type="button"
            className="p-mini-btn"
            onClick={() => {
              if (!applyServiceWorkerUpdate()) window.location.reload();
            }}
          >
            Yenile
          </button>
        )}
      </div>
      <button type="button" className="p-btn p-btn--danger p-btn--block" onClick={logout} disabled={leaving}>
        {leaving ? "Çıkış yapılıyor…" : "Çıkış yap"}
      </button>
    </section>
  );
}
