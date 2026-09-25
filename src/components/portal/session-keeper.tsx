"use client";

import { useEffect } from "react";

/**
 * V7a — kaydırmalı oturumun (K25) istemci yarısı. Görünmez.
 *
 * Server component çerez yazamadığı için yenileme `POST /api/portal/session`
 * üzerinden. Layout yenileme vaktini (`renewAt`, çerezin bitişi − 15 gün)
 * verir; vakit gelmediyse HİÇ istek atılmaz. Ana ekran uygulaması günlerce
 * açık kalıp yalnızca arka plandan öne gelebildiği için kontrol sayfa
 * yüklenince ve `visibilitychange` → görünür olunca yapılıyor.
 *
 * Hata sessiz: yenileme olmazsa oturum eski süresiyle yaşamaya devam eder ve
 * bir sonraki açılışta yeniden denenir. Kullanıcıya gösterilecek bir şey yok.
 */
export function SessionKeeper({ renewAt }: { renewAt: number }) {
  useEffect(() => {
    let due = renewAt;
    let busy = false;

    async function check() {
      if (busy || Date.now() < due) return;
      busy = true;
      try {
        const res = await fetch("/api/portal/session", { method: "POST" });
        if (!res.ok) return;
        const data = (await res.json().catch(() => ({}))) as { renewAt?: string };
        const next = data.renewAt ? Date.parse(data.renewAt) : NaN;
        if (Number.isFinite(next)) due = next;
      } catch {
        // Ağ yok: bir sonraki görünürlükte yeniden.
      } finally {
        busy = false;
      }
    }

    void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [renewAt]);

  return null;
}
