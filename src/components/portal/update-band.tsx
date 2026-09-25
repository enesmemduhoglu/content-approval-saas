"use client";

import { useEffect, useState } from "react";
import {
  SW_UPDATE_EVENT,
  applyServiceWorkerUpdate,
  hasWaitingServiceWorker,
} from "@/components/portal/sw-register";
import { IconClose } from "@/components/portal/icons";

/**
 * "Yeni sürüm hazır — Yenile" bandı (V7-pwa §4.6). `sw-register`'ın yaydığı
 * olayı dinler; `skipWaiting` yalnızca kullanıcı "Yenile"ye dokununca — bir
 * yükleme sürerken sayfanın altından SW değişmesin.
 *
 * Kapatılabilir: kullanıcı o an yenilemek istemeyebilir (ör. caption
 * düzenliyor). Bekleyen SW yerinde kalır, bir sonraki açılışta zaten devralır.
 */
export function UpdateBand() {
  const [ready, setReady] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    // Olay bu bileşen takılmadan önce yayılmış olabilir (kayıt layout'ta,
    // sayfalar arası geçişte bant yeniden takılıyor).
    if (hasWaitingServiceWorker()) setReady(true);
    const onUpdate = () => {
      setReady(true);
      setHidden(false);
    };
    window.addEventListener(SW_UPDATE_EVENT, onUpdate);
    return () => window.removeEventListener(SW_UPDATE_EVENT, onUpdate);
  }, []);

  if (!ready || hidden) return null;

  return (
    <div className="p-update" role="status">
      <p className="p-update-text">Yeni sürüm hazır</p>
      <button
        type="button"
        className="p-update-btn"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          // Bekleyen SW yoksa (başka sekme çoktan devraldı) düz yenileme yeter.
          if (!applyServiceWorkerUpdate()) window.location.reload();
        }}
      >
        {applying ? "Yenileniyor…" : "Yenile"}
      </button>
      <button type="button" className="p-icon-btn" aria-label="Şimdi değil" onClick={() => setHidden(true)}>
        <IconClose size={16} />
      </button>
    </div>
  );
}
