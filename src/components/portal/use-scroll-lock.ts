"use client";

import { useEffect } from "react";

/**
 * Alttan açılan sayfa (sheet) açıkken arka sayfayı kilitler, kapanınca
 * kaldığı yere döndürür.
 *
 * Neden `overflow: hidden` değil: iOS Safari (ve ana ekrandaki PWA) body'deki
 * `overflow: hidden`ı dokunmatik kaydırmada her sürümde uygulamıyor — sheet
 * kendi içinde kaymazken arkadaki sayfa kayıyordu (2026-11-25, iPhone
 * ekran görüntüsü). Güvenilir yol body'yi `position: fixed` ile o anki
 * kaydırma konumunda dondurmak; kapanışta konum geri yüklenir.
 *
 * İç içe iki sheet açılırsa (ör. onay sayfası) ilk kilidin değerleri korunur:
 * sayaç sıfıra inince serbest bırakılır.
 */
let locks = 0;
let saved: { scrollY: number; position: string; top: string; width: string } | null = null;

export function useScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    const body = document.body;
    if (locks === 0) {
      saved = {
        scrollY: window.scrollY,
        position: body.style.position,
        top: body.style.top,
        width: body.style.width,
      };
      body.style.position = "fixed";
      body.style.top = `-${saved.scrollY}px`;
      body.style.width = "100%";
    }
    locks += 1;
    return () => {
      locks -= 1;
      if (locks > 0 || !saved) return;
      const { scrollY, position, top, width } = saved;
      saved = null;
      body.style.position = position;
      body.style.top = top;
      body.style.width = width;
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}
