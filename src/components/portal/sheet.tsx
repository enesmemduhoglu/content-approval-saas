"use client";

import { useEffect, useRef, type ReactNode, type TouchEvent } from "react";
import { IconClose } from "@/components/portal/icons";
import { useScrollLock } from "@/components/portal/use-scroll-lock";

/**
 * Portalın alttan açılan sayfası (sheet) — çerçeve, kapatma yolları ve
 * arka sayfa kilidi tek yerde. Reklam sayfası ve silme onayı kullanıyor.
 *
 * Kapatmanın dört yolu (2026-11-25 iPhone geri bildirimi: "kapatmak zor"):
 *   • Arka plana (gri alan) dokunmak. iOS Safari `cursor: pointer` taşımayan
 *     `div`'e tıklama iletmiyor — eskiden tam bu yüzden çalışmıyordu (CSS).
 *   • Aşağı kaydırmak: tutamaçtan/başlıktan her zaman, içerikten yalnızca
 *     içerik en üstteyken (yoksa içeriği kaydırmak sayfayı kapatırdı).
 *   • Sağ üstteki kapat düğmesi.
 *   • Escape (klavye).
 * `busy` iken (istek uçuşta) hiçbiri çalışmaz: yarım kalan işlemin sonucu
 * kapanmış bir sayfaya düşmesin.
 */

/** Bu kadar aşağı çekilen sayfa bırakılınca kapanır (px). */
export const SWIPE_CLOSE_PX = 110;
/** Daha kısa ama hızlı bir fiske de kapatır: px/ms ve asgari mesafe. */
const SWIPE_FLICK_SPEED = 0.6;
const SWIPE_FLICK_MIN_PX = 40;
const CLOSE_ANIMATION_MS = 180;

/** Kaydırmanın KAPATMA sayılmayacağı yerler: yazı alanında parmak metni seçer/kaydırır. */
const NO_SWIPE = "textarea, input, select";

export function Sheet({
  titleId,
  title,
  busy = false,
  onClose,
  children,
}: {
  titleId: string;
  title: ReactNode;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startT: number; dy: number; grab: boolean } | null>(null);
  const closing = useRef(false);
  useScrollLock();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  function setOffset(dy: number | null, animate: boolean) {
    const el = sheetRef.current;
    if (!el) return;
    el.style.transition = animate ? `transform ${CLOSE_ANIMATION_MS}ms ease-out` : "none";
    el.style.transform = dy === null ? "" : `translateY(${dy}px)`;
  }

  function onTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (busy || closing.current) return;
    const target = event.target as HTMLElement;
    if (target.closest(NO_SWIPE)) return;
    const grab = Boolean(target.closest("[data-sheet-grab]"));
    // İçerik aşağı kaydırılmışsa aşağı çekmek içeriği geri kaydırır; kapatma
    // yalnızca tutamaç/başlıktan ya da içerik en üstteyken.
    if (!grab && (sheetRef.current?.scrollTop ?? 0) > 0) return;
    const y = event.touches[0]?.clientY;
    if (y === undefined) return;
    drag.current = { startY: y, startT: Date.now(), dy: 0, grab };
  }

  function onTouchMove(event: TouchEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    const y = event.touches[0]?.clientY;
    if (y === undefined) return;
    // İçerik bu arada kaydırıldıysa (yukarı itip geri çekme) sürükleme biter.
    if (!state.grab && (sheetRef.current?.scrollTop ?? 0) > 0) {
      drag.current = null;
      setOffset(null, true);
      return;
    }
    state.dy = Math.max(0, y - state.startY);
    setOffset(state.dy, false);
  }

  function onTouchEnd() {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    const speed = state.dy / Math.max(1, Date.now() - state.startT);
    const close =
      state.dy >= SWIPE_CLOSE_PX || (state.dy >= SWIPE_FLICK_MIN_PX && speed >= SWIPE_FLICK_SPEED);
    if (!close) {
      setOffset(null, true);
      return;
    }
    closing.current = true;
    setOffset(window.innerHeight, true);
    window.setTimeout(onClose, CLOSE_ANIMATION_MS);
  }

  return (
    <div className="p-sheet-layer">
      <div
        className="p-sheet-backdrop"
        data-testid="sheet-backdrop"
        aria-hidden="true"
        onClick={busy ? undefined : onClose}
      />
      <div
        ref={sheetRef}
        className="p-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <div className="p-sheet-top" data-sheet-grab="">
          <span className="p-sheet-handle" aria-hidden="true" />
          <div className="p-sheet-headrow">
            <h2 className="p-sheet-title" id={titleId}>
              {title}
            </h2>
            <button
              type="button"
              className="p-sheet-close"
              aria-label="Kapat"
              disabled={busy}
              onClick={onClose}
            >
              <IconClose size={20} />
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
