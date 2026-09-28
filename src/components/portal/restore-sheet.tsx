"use client";

import { useEffect } from "react";
import { IconCheck, IconClock } from "@/components/portal/icons";

export type RestoreSheetProps = {
  /** Listeden açılınca hangi video olduğu (kapak + caption başı). */
  caption?: string;
  coverUrl?: string | null;
  /** Onaylı dönüş caption hazır değilse kapalı (sunucu da 409 verir). */
  captionReady: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onChoose: (approve: boolean) => void;
};

/**
 * Reddedilen videoyu kuyruğa geri alma (V7 tasarımı, "Reddedilen video ·
 * kuyruğa geri al"). İki yol: onaylayıp al (sırası gelince yayınlanır) ya da
 * onay bekleyen olarak al (önce caption düzeltilecekse). Onay kapalıyken bu
 * sayfa açılmaz; çağıran doğrudan geri alır.
 */
export function RestoreSheet(props: RestoreSheetProps) {
  const { busy, onCancel } = props;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="p-sheet-layer">
      <div className="p-sheet-backdrop" aria-hidden="true" onClick={busy ? undefined : onCancel} />
      <div className="p-sheet" role="dialog" aria-modal="true" aria-labelledby="p-restore-title">
        <span className="p-sheet-handle" aria-hidden="true" />
        <h2 className="p-sheet-title" id="p-restore-title">
          Kuyruğa geri al
        </h2>
        {props.caption !== undefined && (
          <div className="p-sheet-video">
            {props.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={props.coverUrl} alt="" className="p-sheet-cover" />
            ) : (
              <span className="p-sheet-cover" aria-hidden="true" />
            )}
            <span className="p-sheet-caption">{props.caption || "Caption yok"}</span>
          </div>
        )}
        <p className="p-sheet-text">Red kalkar, video sıranın sonuna eklenir.</p>
        {props.error && (
          <p className="p-error" role="alert">
            {props.error}
          </p>
        )}
        <button
          type="button"
          className="p-choice p-choice--primary"
          disabled={busy || !props.captionReady}
          onClick={() => props.onChoose(true)}
        >
          <span className="p-choice-icon" aria-hidden="true">
            <IconCheck size={18} />
          </span>
          <span className="p-choice-text">
            <span className="p-choice-title">Onaylayıp kuyruğa al</span>
            <span className="p-choice-sub">
              {props.captionReady ? "Sırası gelince yayınlanır" : "Caption hazır olunca onaylayabilirsin"}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="p-choice"
          disabled={busy}
          onClick={() => props.onChoose(false)}
        >
          <span className="p-choice-icon" aria-hidden="true">
            <IconClock size={18} />
          </span>
          <span className="p-choice-text">
            <span className="p-choice-title">Onay bekleyen olarak al</span>
            <span className="p-choice-sub">Önce caption&apos;ı düzeltmek istersen · onaylayınca takvime girer</span>
          </span>
        </button>
        <button type="button" className="p-textbtn p-sheet-cancel" disabled={busy} onClick={onCancel}>
          Vazgeç
        </button>
      </div>
    </div>
  );
}

/**
 * `POST /api/portal/videos/:id/restore`. `position`: redden hemen sonra
 * "Geri al"da videonun eski sırası; yoksa sona eklenir.
 */
export async function restoreVideo(
  id: string,
  approve: boolean,
  position?: number | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/portal/videos/${id}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(position === undefined || position === null ? { approve } : { approve, position }),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error ?? "Video kuyruğa alınamadı, tekrar dene" };
  } catch {
    return { ok: false, error: "Bağlantı hatası, tekrar dene" };
  }
}

/** Kuyruktan çıkarılmış (reddedilmemiş) videoyu sona alır — mevcut "Sona at" yolu. */
export async function requeueVideo(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/portal/videos/${id}/to-end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error ?? "Video kuyruğa alınamadı, tekrar dene" };
  } catch {
    return { ok: false, error: "Bağlantı hatası, tekrar dene" };
  }
}
