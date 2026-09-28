"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";
import { CAPTION_MAX_LENGTH } from "@/lib/validation";
import type { ReviewNext } from "@/lib/portal-review";
import { DeleteSheet, deleteVideo } from "@/components/portal/delete-sheet";
import { RestoreSheet, restoreVideo } from "@/components/portal/restore-sheet";
import {
  IconCheck,
  IconChevronRight,
  IconRefresh,
  IconSparkle,
  IconTrash,
  IconUndo,
} from "@/components/portal/icons";

/** Redden sonra "Geri al"ın açık kaldığı süre (sn). */
export const UNDO_SECONDS = 8;

/**
 * "Yeniden üret" notunun hazır parçaları (V7, "Güncelleme 28 Eyl (3)").
 * Telefonda not yazmak zahmetli; en sık istenenler caption-stili.md'nin
 * ayarlanabilir yerlerinden: uzunluk, ton, kanca, emoji, hashtag, CTA.
 */
export const NOTE_CHIPS = [
  "Daha kısa",
  "Daha samimi",
  "Kanca daha güçlü",
  "Emoji yok",
  "Daha az hashtag",
  "Kaydetmeye çağır",
] as const;

const lower = (text: string) => text.trim().toLocaleLowerCase("tr");

/** Nottaki virgülle ayrılmış parçalar; çip bunlardan biriyse "basılı". */
function noteParts(note: string): string[] {
  return note
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function chipActive(note: string, chip: string): boolean {
  return noteParts(note).some((part) => lower(part) === lower(chip));
}

/** Çipi nota ekler ya da çıkarır; elle yazılmış diğer parçalar yerinde kalır. */
export function toggleChip(note: string, chip: string): string {
  const parts = noteParts(note);
  const next = chipActive(note, chip)
    ? parts.filter((part) => lower(part) !== lower(chip))
    : [...parts, lower(chip)];
  return next.join(", ");
}

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
  /** "Tekrar dene"nin üstündeki uyarı (ör. biçim hatasında tekrar denemek boşuna). */
  retryNote?: string;
  /** Onay bekleyenler arasında gezinme (`reviewNext`); onay kapalıyken yok. */
  review?: ReviewNext;
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
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  /** Redden hemen sonra: videonun eski sırası ve kalan saniye. */
  const [undo, setUndo] = useState<{ position: number | null; left: number } | null>(null);
  /**
   * Onaydan hemen sonra: sıradaki bekleyen video. Onay anındaki `review`dan
   * alınır — sayfa tazelenince bu video artık "bekleyen" sayılmıyor.
   */
  const [approvedNext, setApprovedNext] = useState<{ nextId: string | null; left: number } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  // Onay kutusu alanın altında açılıyor ve sabit eylem çubuğunun arkasında
  // kalabiliyordu; açılınca görünür alana kaydırılır (2026-09-28 analizi).
  useEffect(() => {
    if (!confirmRegenerate) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    confirmRef.current?.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, [confirmRegenerate]);

  const editable =
    (props.status === "pending" || props.status === "approved") &&
    (props.publishStatus === "idle" || props.publishStatus === "failed");
  const captionReady = props.captionStatus === "ready";
  const captionBusy = props.captionStatus === "pending" || props.captionStatus === "generating";
  const canEditCaption = editable && (captionReady || props.captionStatus === "failed");

  /** Başarıda yanıt gövdesini döner (red eski sırayı taşıyor), hatada `null`. */
  async function call(
    path: string,
    body: unknown,
    done: string,
    method = "POST"
  ): Promise<Record<string, unknown> | null> {
    if (busy) return null;
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
        return null;
      }
      setMessage(done);
      setConfirmRegenerate(false);
      setRejecting(false);
      router.refresh();
      return data;
    } catch {
      setError("Bağlantı hatası, tekrar dene");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    const data = await call(
      "/decision",
      { action: "reject", reason: reason.trim() || undefined },
      "Video reddedildi ve kuyruktan çıkarıldı"
    );
    if (!data) return;
    // Mesaj yerine "Geri al" bildirimi: yanlışlıkla reddetmenin fark edildiği an bu.
    setMessage(null);
    const previous = typeof data.previousPosition === "number" ? data.previousPosition : null;
    setUndo({ position: previous, left: UNDO_SECONDS });
  }

  async function approve() {
    const review = props.review;
    const data = await call(
      "/decision",
      { action: "approve" },
      "Onaylandı. Video kuyruktaki sırası gelince yayınlanacak."
    );
    if (!data || !review) return;
    // Onay açıkken mesaj yerine "sıradakine geç" satırı (V7, 28 Eyl (3)).
    setMessage(null);
    const left = Math.max(0, review.awaiting - (review.index !== null ? 1 : 0));
    setApprovedNext({ nextId: review.nextId, left });
  }

  // Geri sayım; süre bitince bildirim kalkar, çubukta "Sil / Kuyruğa geri al" kalır.
  const undoActive = undo !== null;
  useEffect(() => {
    if (!undoActive) return;
    const timer = setInterval(() => {
      setUndo((current) => (current && current.left > 1 ? { ...current, left: current.left - 1 } : null));
    }, 1000);
    return () => clearInterval(timer);
  }, [undoActive]);

  /**
   * Reddi geri al. `position` yalnızca redden hemen sonraki "Geri al"da dolu
   * (video eski yerine döner); detaydan/listeden geri almada video sona eklenir.
   */
  async function restore(approve: boolean, position: number | null, done: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setRestoreError(null);
    const result = await restoreVideo(props.id, approve, position);
    setBusy(false);
    if (!result.ok) {
      if (restoring) setRestoreError(result.error);
      else setError(result.error);
      return;
    }
    setUndo(null);
    setRestoring(false);
    setMessage(done);
    router.refresh();
  }

  const closeRestore = useCallback(() => {
    setRestoring(false);
    setRestoreError(null);
  }, []);

  function startRestore() {
    setMessage(null);
    setError(null);
    // Onay kapalıyken "onaylı / onay bekleyen" ayrımı anlamsız: doğrudan geri al.
    if (!props.requireApproval) {
      void restore(false, null, "Video kuyruğa geri alındı");
      return;
    }
    setRestoring(true);
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
  const rejected = props.status === "rejected";
  // `undo` açıkken sayfa henüz tazelenmemiş olabilir (status hâlâ `pending`):
  // karar düğmeleri "Geri al"ın yanında görünmesin.
  const pendingDecision =
    props.status === "pending" && !outside && undo === null && approvedNext === null;
  const canRetry = editable && props.publishStatus === "failed" && props.inQueue;
  const dirty = caption.trim() !== props.caption.trim();
  // Mesajlar da çubukta: sonucu, dokunulan düğmenin hemen üstünde görsün.
  const showBar =
    pendingDecision ||
    canRetry ||
    outside ||
    undo !== null ||
    approvedNext !== null ||
    message !== null ||
    error !== null;
  const review = props.review;

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
              okunmadan geçilmesin diye görünür. Reddedilen video yayınlanmayacağı
              için orada gürültü — kuyruğa geri alınınca yeniden çıkar. */}
          {captionReady && !rejected && (
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
            {rejected && (
              <p className="p-hint">Kuyruğa geri alınca caption&apos;ı düzenleyebilirsin.</p>
            )}
          </div>
        </>
      )}

      {editable && !captionBusy && (
        <div className="p-field">
          <label htmlFor="regen-note" className="p-label">
            Yeniden üret
          </label>
          <div className="p-notechips" role="group" aria-label="Hazır notlar">
            {NOTE_CHIPS.map((chip) => {
              const on = chipActive(note, chip);
              return (
                <button
                  key={chip}
                  type="button"
                  className={`p-notechip${on ? " p-notechip--on" : ""}`}
                  aria-pressed={on}
                  disabled={busy || confirmRegenerate}
                  onClick={() => setNote((current) => toggleChip(current, chip))}
                >
                  {on && <IconCheck size={13} />}
                  {chip}
                </button>
              );
            })}
          </div>
          <div className="p-inline">
            <input
              id="regen-note"
              type="text"
              className="p-input"
              maxLength={500}
              placeholder="Ya da kendin yaz: ör. kancayı soruyla aç"
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
            <div
              ref={confirmRef}
              className="p-confirm"
              role="alertdialog"
              aria-label="Yeniden üretme onayı"
            >
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

      {restoring && (
        <RestoreSheet
          captionReady={captionReady}
          busy={busy}
          error={restoreError}
          onCancel={closeRestore}
          onChoose={(approve) =>
            restore(
              approve,
              null,
              approve ? "Onaylandı ve kuyruğa alındı" : "Kuyruğa alındı · onayını bekliyor"
            )
          }
        />
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
            {pendingDecision && !rejecting && review && review.index !== null && review.awaiting > 1 && (
              <p className="p-hint p-hint--center">
                Onay bekleyen {review.awaiting} videodan {review.index}.
              </p>
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
                    onClick={() => void reject()}
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
                  onClick={() => void approve()}
                >
                  <IconCheck size={18} />
                  Onayla
                </button>
              </div>
            )}
            {approvedNext && (
              <>
                <div className="p-approved" role="status">
                  <span className="p-approved-check" aria-hidden="true">
                    <IconCheck size={14} />
                  </span>
                  <span className="p-approved-text">
                    <strong>Onaylandı</strong>
                    <span>
                      {approvedNext.nextId
                        ? "Sırası gelince yayınlanacak"
                        : "Sırası gelince yayınlanacak · onay bekleyen başka video yok"}
                    </span>
                  </span>
                </div>
                <div className="p-actionbar-row">
                  {approvedNext.nextId ? (
                    <>
                      <Link href="/portal" className="p-btn p-btn--outline">
                        Kuyruk
                      </Link>
                      <Link
                        href={`/portal/video/${approvedNext.nextId}`}
                        className="p-btn p-btn--primary p-btn--grow"
                      >
                        Sıradakine geç · {approvedNext.left} kaldı
                        <IconChevronRight size={18} />
                      </Link>
                    </>
                  ) : (
                    <Link href="/portal" className="p-btn p-btn--primary p-btn--grow">
                      Kuyruğa dön
                    </Link>
                  )}
                </div>
              </>
            )}
            {undo && (
              <div className="p-undo" role="status">
                <span className="p-undo-text">
                  <strong>Video reddedildi</strong>
                  <span>Kuyruktan çıkarıldı · {undo.left} sn içinde geri alabilirsin</span>
                </span>
                <button
                  type="button"
                  className="p-undo-btn"
                  disabled={busy}
                  onClick={() =>
                    restore(false, undo.position, "Red geri alındı · video eski yerine döndü")
                  }
                >
                  <IconUndo size={16} />
                  Geri al
                </button>
              </div>
            )}
            {outside && !undo && (
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
                {(editable || rejected) && (
                  <button
                    type="button"
                    className="p-btn p-btn--primary p-btn--grow"
                    disabled={busy}
                    onClick={() =>
                      rejected ? startRestore() : call("/to-end", {}, "Video kuyruğa geri alındı")
                    }
                  >
                    <IconUndo size={18} />
                    Kuyruğa geri al
                  </button>
                )}
              </div>
            )}
            {!pendingDecision && canRetry && props.retryNote && (
              <p className="p-hint p-hint--center">{props.retryNote}</p>
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
