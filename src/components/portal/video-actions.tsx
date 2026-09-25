"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";

export type VideoActionsProps = {
  id: string;
  caption: string;
  status: PostStatus;
  captionStatus: CaptionStatus | null;
  publishStatus: PublishStatus;
  inQueue: boolean;
  requireApproval: boolean;
};

/**
 * Video detayındaki bütün işlemler. Hangi butonun görüneceği, sunucudaki
 * koşullu UPDATE'lerin kabul edeceği durumlarla aynı mantıkta — kullanıcı
 * 409 alacağı bir butonu hiç görmesin. Sunucu yine de son sözü söyler.
 */
export function VideoActions(props: VideoActionsProps) {
  const router = useRouter();
  const [caption, setCaption] = useState(props.caption);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [rejecting, setRejecting] = useState(false);
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

  return (
    <div className="video-actions">
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}

      <section className="card video-section">
        <h2>Caption</h2>
        {captionBusy ? (
          <p className="settings-hint">Caption hazırlanıyor. Birkaç dakika sonra sayfayı yenile.</p>
        ) : (
          <div className="form">
            {/* Whisper sayıları yanlış duyabiliyor ("15" → "50"); yayından önce
                okunmadan geçilmesin diye her zaman görünür. */}
            {captionReady && (
              <p className="settings-hint caption-auto-note">
                Caption videodaki konuşmadan otomatik üretilir ve yanlış duyulmuş kelimeler
                içerebilir. Yayından önce özellikle sayıları, isimleri ve yazımı kontrol et.
              </p>
            )}
            <label>
              <span className="sr-only">Caption metni</span>
              <textarea
                className="post-edit-caption video-caption-input"
                rows={10}
                value={caption}
                disabled={!canEditCaption || busy}
                onChange={(e) => setCaption(e.target.value)}
              />
            </label>
            {canEditCaption && (
              <div className="form-actions">
                <button
                  type="button"
                  className="button-primary"
                  disabled={busy || caption.trim() === props.caption.trim() || !caption.trim()}
                  onClick={() => call("", { caption }, "Caption kaydedildi", "PATCH")}
                >
                  Caption&apos;ı kaydet
                </button>
              </div>
            )}
          </div>
        )}

        {editable && !captionBusy && (
          <div className="form">
            <label>
              Yeniden üret (isteğe bağlı not)
              <input
                type="text"
                maxLength={500}
                placeholder="ör. daha kısa olsun"
                value={note}
                disabled={busy}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            {confirmRegenerate ? (
              <div className="portal-confirm" role="alertdialog" aria-label="Yeniden üretme onayı">
                {/* KARARLAR "Açık sorular": elle düzenleme kaybolur — önce söyle. */}
                <p>
                  Caption baştan üretilecek; elle yaptığın değişiklikler kaybolur.
                  {props.status === "approved" && " Video yeniden onayını bekleyecek."}
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button-primary"
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
                    className="button-secondary"
                    disabled={busy}
                    onClick={() => setConfirmRegenerate(false)}
                  >
                    Vazgeç
                  </button>
                </div>
              </div>
            ) : (
              <div className="form-actions">
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => setConfirmRegenerate(true)}
                >
                  Yeniden üret
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {props.status === "pending" && (
        <section className="card video-section">
          <h2>Karar</h2>
          {!props.requireApproval && (
            <p className="settings-hint">
              Onay kapalı: bu video sırası gelince onay beklemeden yayınlanır. Yayınlanmasını
              istemiyorsan reddet ya da kuyruktan çıkar.
            </p>
          )}
          {!captionReady && (
            <p className="settings-hint">Caption hazır olunca onaylayabilirsin.</p>
          )}
          {rejecting ? (
            <div className="form">
              <label>
                Neden? (isteğe bağlı)
                <input
                  type="text"
                  maxLength={2000}
                  value={reason}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  className="button-reject"
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
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => setRejecting(false)}
                >
                  Vazgeç
                </button>
              </div>
            </div>
          ) : (
            <div className="form-actions">
              <button
                type="button"
                className="button-approve"
                disabled={busy || !captionReady}
                onClick={() =>
                  call(
                    "/decision",
                    { action: "approve" },
                    "Onaylandı. Video kuyruktaki sırası gelince yayınlanacak."
                  )
                }
              >
                Onayla
              </button>
              <button
                type="button"
                className="button-reject"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                Reddet
              </button>
            </div>
          )}
        </section>
      )}

      {editable && (
        <section className="card video-section">
          <h2>Kuyruk</h2>
          <div className="form-actions">
            {props.publishStatus === "failed" && props.inQueue && (
              <button
                type="button"
                className="button-primary"
                disabled={busy}
                onClick={() =>
                  call("/retry", {}, "Bir sonraki yayın saatinde yeniden denenecek")
                }
              >
                Tekrar dene
              </button>
            )}
            <button
              type="button"
              className="button-secondary"
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
            {props.inQueue && (
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                onClick={() => call("/remove", {}, "Video kuyruktan çıkarıldı")}
              >
                Kuyruktan çıkar
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
