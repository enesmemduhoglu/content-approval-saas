"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";
import { CAPTION_MAX_LENGTH } from "@/lib/validation";
import { DeleteSheet, deleteVideo } from "@/components/portal/delete-sheet";
import { IconCheck, IconRefresh, IconSparkle, IconTrash } from "@/components/portal/icons";

export type VideoActionsProps = {
  id: string;
  caption: string;
  status: PostStatus;
  captionStatus: CaptionStatus | null;
  publishStatus: PublishStatus;
  inQueue: boolean;
  requireApproval: boolean;
  /**
   * Kalıcı silme: yalnızca kuyruk dışındaki (çıkarılan ya da reddedilen),
   * yayına girmemiş video. Koşul sunucudaki `posts.deleteOutside` ile aynı.
   */
  canDelete: boolean;
};

/**
 * Video detayındaki bütün işlemler. Hangi butonun görüneceği, sunucudaki
 * koşullu UPDATE'lerin kabul edeceği durumlarla aynı mantıkta — kullanıcı
 * 409 alacağı bir butonu hiç görmesin. Sunucu yine de son sözü söyler.
 *
 * Görünüm V7 mobil tasarımı: karar (Onayla/Reddet) ve "Tekrar dene" başparmak
 * hizasında, ekranın altına sabit bir çubukta; caption düzenleme ve kuyruk
 * araçları sayfanın akışında.
 */
export function VideoActions(props: VideoActionsProps) {
  const router = useRouter();
  const [caption, setCaption] = useState(props.caption);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editable =
    (props.status === "pending" || props.status === "approved") &&
    (props.publishStatus === "idle" || props.publishStatus === "failed");
  const captionReady = props.captionStatus === "ready";
  const captionBusy = props.captionStatus === "pending" || props.captionStatus === "generating";
  const canEditCaption = editable && (captionReady || props.captionStatus === "failed");

  async function call(path: string, body: unknown, done: string, method = "POST") {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/portal/videos/${props.id}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Bir hata oluştu, tekrar dene");
        return;
      }
      setMessage(done);
      setConfirmRegenerate(false);
      setRejecting(false);
      router.refresh();
    } catch {
      setError("Bağlantı hatası, tekrar dene");
    } finally {
      setBusy(false);
    }
  }

  const closeDelete = useCallback(() => {
    setDeleting(false);
    setDeleteError(null);
  }, []);

  async function confirmDelete() {
    if (busy) return;
    setBusy(true);
    setDeleteError(null);
    const result = await deleteVideo(props.id);
    if (!result.ok) {
      setDeleteError(result.error);
      setBusy(false);
      return;
    }
    // Sayfanın kendisi artık yok: kuyruğa dönülür (orada "Kuyruk dışı" tazelenmiş).
    router.replace("/portal");
    router.refresh();
  }

  // Kuyruk dışındaki videoda karar (Onayla/Reddet) çubuğu yerine "Sil" +
  // "Kuyruğa geri al": yayınlanmayacak bir videoyu onaylamak anlamsız, önce
  // kuyruğa geri alınır.
  const outside = !props.inQueue && props.canDelete;
  const pendingDecision = props.status === "pending" && !outside;
  const canRetry = editable && props.publishStatus === "failed" && props.inQueue;
  const dirty = caption.trim() !== props.caption.trim();
  // Mesajlar da çubukta: sonucu, dokunulan düğmenin hemen üstünde görsün.
  const showBar = pendingDecision || canRetry || outside || message !== null || error !== null;

  return (
    <>
      {captionBusy ? (
        <p className="p-note">
          <IconSparkle size={18} />
          <span>
            Caption hazırlanıyor — konuşma yazıya dökülüyor. Birkaç dakika sonra sayfayı yenile.
          </span>
        </p>
      ) : (
        <>
          {/* Whisper sayıları yanlış duyabiliyor ("15" → "50"); yayından önce
              okunmadan geçilmesin diye her zaman görünür. */}
          {captionReady && (
            <p className="p-note">
              <IconSparkle size={18} />
              <span>
                Caption otomatik üretildi. <strong>Sayıları ve isimleri kontrol et</strong> — konuşma
                yazıya dökülürken yanlış duyulabilir.
              </span>
            </p>
          )}
          <div className="p-field">
            <div className="p-field-head">
              <label htmlFor="caption" className="p-label">
                Caption
              </label>
              <span
                className={`p-counter${caption.length > CAPTION_MAX_LENGTH ? " p-counter--over" : ""}`}
              >
                {caption.length} / {CAPTION_MAX_LENGTH}
              </span>
            </div>
            <textarea
              id="caption"
              className="p-textarea"
              rows={10}
              value={caption}
              disabled={!canEditCaption || busy}
              onChange={(e) => setCaption(e.target.value)}
            />
            {/* Kaydet yalnızca değişiklik varken: maket sade bir metin alanı
                gösteriyor, her zaman duran pasif bir düğme gürültü olurdu. */}
            {canEditCaption && dirty && (
              <button
                type="button"
                className="p-btn p-btn--primary p-btn--block"
                disabled={busy || !caption.trim()}
                onClick={() => call("", { caption }, "Caption kaydedildi", "PATCH")}
              >
                Caption&apos;ı kaydet
              </button>
            )}
          </div>
        </>
      )}

      {editable && !captionBusy && (
        <div className="p-field">
          <label htmlFor="regen-note" className="p-label">
            Yeniden üret
          </label>
          <div className="p-inline">
            <input
              id="regen-note"
              type="text"
              className="p-input"
              maxLength={500}
              placeholder="Not ekle: ör. daha kısa olsun"
              value={note}
              disabled={busy || confirmRegenerate}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              type="button"
              className="p-square"
              aria-label="Yeniden üret"
              disabled={busy || confirmRegenerate}
              onClick={() => setConfirmRegenerate(true)}
            >
              <IconRefresh size={20} />
            </button>
          </div>
          {confirmRegenerate && (
            <div className="p-confirm" role="alertdialog" aria-label="Yeniden üretme onayı">
              {/* KARARLAR "Açık sorular": elle düzenleme kaybolur — önce söyle. */}
              <p>
                Caption baştan üretilecek; elle yaptığın değişiklikler kaybolur.
                {props.status === "approved" && " Video yeniden onayını bekleyecek."}
              </p>
              <div className="p-confirm-actions">
                <button
                  type="button"
                  className="p-btn p-btn--primary"
                  disabled={busy}
                  onClick={() =>
                    call(
                      "/regenerate",
                      note.trim() ? { note: note.trim() } : {},
                      "Yeni caption hazırlanıyor"
                    )
                  }
                >
                  Evet, yeniden üret
                </button>
                <button
                  type="button"
                  className="p-btn p-btn--outline"
                  disabled={busy}
                  onClick={() => setConfirmRegenerate(false)}
                >
                  Vazgeç
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {editable && !outside && (
        <div className="p-tools">
          {props.inQueue && (
            <button
              type="button"
              className="p-textbtn p-textbtn--danger"
              disabled={busy}
              onClick={() => call("/remove", {}, "Video kuyruktan çıkarıldı")}
            >
              Kuyruktan çıkar
            </button>
          )}
          <button
            type="button"
            className="p-textbtn"
            disabled={busy}
            onClick={() =>
              call(
                "/to-end",
                {},
                props.inQueue ? "Video kuyruğun sonuna taşındı" : "Video kuyruğa geri alındı"
              )
            }
          >
            {props.inQueue ? "Sona at" : "Kuyruğa geri al"}
          </button>
        </div>
      )}

      {deleting && (
        <DeleteSheet busy={busy} error={deleteError} onCancel={closeDelete} onConfirm={confirmDelete} />
      )}

      {showBar && (
        <div className="p-actionbar">
          <div className="p-actionbar-inner">
            {error && (
              <p className="p-error" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p className="p-hint" role="status">
                {message}
              </p>
            )}
            {pendingDecision && !rejecting && !props.requireApproval && (
              <p className="p-hint">
                Onay kapalı: sırası gelince onay beklemeden yayınlanır. İstemiyorsan reddet ya da
                kuyruktan çıkar.
              </p>
            )}
            {pendingDecision && !rejecting && !captionReady && (
              <p className="p-hint">Caption hazır olunca onaylayabilirsin.</p>
            )}
            {pendingDecision && rejecting && (
              <>
                <label htmlFor="reject-reason" className="p-label">
                  Neden? (isteğe bağlı)
                </label>
                <input
                  id="reject-reason"
                  type="text"
                  className="p-input"
                  maxLength={2000}
                  value={reason}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="p-actionbar-row">
                  <button
                    type="button"
                    className="p-btn p-btn--outline"
                    disabled={busy}
                    onClick={() => setRejecting(false)}
                  >
                    Vazgeç
                  </button>
                  <button
                    type="button"
                    className="p-btn p-btn--solid-danger p-btn--grow"
                    disabled={busy}
                    onClick={() =>
                      call(
                        "/decision",
                        { action: "reject", reason: reason.trim() || undefined },
                        "Video reddedildi ve kuyruktan çıkarıldı"
                      )
                    }
                  >
                    Reddet
                  </button>
                </div>
              </>
            )}
            {pendingDecision && !rejecting && (
              <div className="p-actionbar-row">
                <button
                  type="button"
                  className="p-btn p-btn--outline"
                  disabled={busy}
                  onClick={() => setRejecting(true)}
                >
                  Reddet
                </button>
                <button
                  type="button"
                  className="p-btn p-btn--primary p-btn--grow"
                  disabled={busy || !captionReady}
                  onClick={() =>
                    call(
                      "/decision",
                      { action: "approve" },
                      "Onaylandı. Video kuyruktaki sırası gelince yayınlanacak."
                    )
                  }
                >
                  <IconCheck size={18} />
                  Onayla
                </button>
              </div>
            )}
            {outside && (
              <div className="p-actionbar-row">
                <button
                  type="button"
                  className="p-btn p-btn--danger"
                  disabled={busy}
                  onClick={() => {
                    setMessage(null);
                    setError(null);
                    setDeleting(true);
                  }}
                >
                  <IconTrash size={18} />
                  Sil
                </button>
                {/* Reddedilen video kuyruğa geri alınamaz (`moveToEnd`); yalnızca silinir. */}
                {editable && (
                  <button
                    type="button"
                    className="p-btn p-btn--primary p-btn--grow"
                    disabled={busy}
                    onClick={() => call("/to-end", {}, "Video kuyruğa geri alındı")}
                  >
                    <IconRefresh size={18} />
                    Kuyruğa geri al
                  </button>
                )}
              </div>
            )}
            {!pendingDecision && canRetry && (
              <div className="p-actionbar-row">
                <button
                  type="button"
                  className="p-btn p-btn--primary p-btn--grow"
                  disabled={busy}
                  onClick={() => call("/retry", {}, "Bir sonraki yayın saatinde yeniden denenecek")}
                >
                  <IconRefresh size={18} />
                  Tekrar dene
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
