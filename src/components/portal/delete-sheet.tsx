"use client";

import { useEffect } from "react";
import { IconTrash } from "@/components/portal/icons";

export type DeleteSheetProps = {
  /** Hangi videonun silineceği: listeden açılınca kapak + caption başı gösterilir. */
  caption?: string;
  coverUrl?: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Kalıcı silme onayı — alttan açılan sayfa (V7 mobil tasarımı, "Kuyruk dışı ·
 * silme"). Geri alınamayan tek portal işlemi bu; tek dokunuşla değil, ayrı bir
 * onayla yapılır. Odak "Vazgeç"te açılır: yanlışlıkla ikinci dokunuş silmesin.
 */
export function DeleteSheet(props: DeleteSheetProps) {
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
      <div className="p-sheet" role="dialog" aria-modal="true" aria-labelledby="p-sheet-title">
        <span className="p-sheet-handle" aria-hidden="true" />
        <h2 className="p-sheet-title" id="p-sheet-title">
          Video silinsin mi?
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
        <p className="p-sheet-text">
          Video, caption&apos;ı ve dosyası kalıcı olarak silinir. <strong>Bu geri alınamaz.</strong>
        </p>
        {props.error && (
          <p className="p-error" role="alert">
            {props.error}
          </p>
        )}
        <div className="p-actionbar-row">
          <button
            type="button"
            className="p-btn p-btn--outline"
            disabled={busy}
            onClick={onCancel}
            autoFocus
          >
            Vazgeç
          </button>
          <button
            type="button"
            className="p-btn p-btn--solid-danger p-btn--grow"
            disabled={busy}
            onClick={props.onConfirm}
          >
            <IconTrash size={18} />
            {busy ? "Siliniyor…" : "Kalıcı olarak sil"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** `DELETE /api/portal/videos/:id` — hata metni kullanıcıya gösterilecek biçimde döner. */
export async function deleteVideo(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/portal/videos/${id}`, { method: "DELETE" });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    // 404: başka sekmede zaten silinmiş — kullanıcının istediği sonuç bu.
    if (res.status === 404) return { ok: true };
    return { ok: false, error: data.error ?? "Video silinemedi, tekrar dene" };
  } catch {
    return { ok: false, error: "Bağlantı hatası, tekrar dene" };
  }
}
