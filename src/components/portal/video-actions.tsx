"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";
import { CAPTION_MAX_LENGTH } from "@/lib/validation";
import { DeleteSheet, deleteVideo } from "@/components/portal/delete-sheet";
import { restoreVideo } from "@/components/portal/requeue";
import { IconCheck, IconRefresh, IconSparkle, IconTrash, IconUndo } from "@/components/portal/icons";

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
  /**
   * Kalıcı silme: yalnızca kuyruk dışındaki (çıkarılan ya da K33 öncesinde reddedilen),
   * yayına girmemiş video. Koşul sunucudaki `posts.deleteOutside` ile aynı.
   */
  canDelete: boolean;
  /** "Tekrar dene"nin üstündeki uyarı (ör. biçim hatasında tekrar denemek boşuna). */
  retryNote?: string;
  /**
   * `pending` caption takılmış (`isCaptionStuck`): iş kuyruğa hiç girmemiş
   * olabilir. Sunucu bu durumda yeniden üretimi kabul ediyor; düğme de açılır.
   */
  captionStuck?: boolean;
};

/**
 * Video detayındaki bütün işlemler. Hangi butonun görüneceği, sunucudaki
 * koşullu UPDATE'lerin kabul edeceği durumlarla aynı mantıkta — kullanıcı
 * 409 alacağı bir butonu hiç görmesin. Sunucu yine de son sözü söyler.
 *
 * Görünüm V7 mobil tasarımı: "Tekrar dene" ve kuyruk dışı videonun "Sil /
 * Kuyruğa geri al"ı başparmak hizasında, ekranın altına sabit bir çubukta;
 * caption düzenleme ve kuyruk araçları sayfanın akışında. Onay/red çubuğu
 * yok: portalda müşteri onayı yok (K33), video sırası gelince yayınlanır.
 */
export function VideoActions(props: VideoActionsProps) {
  const router = useRouter();
  const [caption, setCaption] = useState(props.caption);
  const [note, setNote] = useState("");
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
  const captionStuck = props.captionStuck === true && props.captionStatus === "pending";
  // Takılı `pending` meşgul sayılmaz: sayılsaydı "Yeniden üret" gizli kalır ve
  // kuyruğa hiç girmemiş videonun portalda kurtarma yolu olmazdı.
  const captionBusy =
    (props.captionStatus === "pending" && !captionStuck) || props.captionStatus === "generating";
  const canEditCaption = editable && (captionReady || props.captionStatus === "failed");

  async function call(path: string, body: unknown, done: string, method = "POST"): Promise<void> {
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
      router.refresh();
    } catch {
      setError("Bağlantı hatası, tekrar dene");
    } finally {
      setBusy(false);
    }
  }

  /**
   * K33 öncesinde reddedilmiş videoyu kuyruğun sonuna geri alır. Yeni red
   * üretilmiyor; bu yol yalnızca o eski kayıtlar için (`/restore`).
   */
  async function restore() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await restoreVideo(props.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMessage("Video kuyruğa geri alındı");
    router.refresh();
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

  // Kuyruk dışındaki videoda çubukta "Sil" + "Kuyruğa geri al".
  const outside = !props.inQueue && props.canDelete;
  const rejected = props.status === "rejected";
  const canRetry = editable && props.publishStatus === "failed" && props.inQueue;
  const dirty = caption.trim() !== props.caption.trim();
  // Mesajlar da çubukta: sonucu, dokunulan düğmenin hemen üstünde görsün.
  const showBar = canRetry || outside || message !== null || error !== null;

  return (
    <>
      {captionBusy ? (
        <p className="p-note">
          <IconSparkle size={18} />
          <span>
            Caption hazırlanıyor — konuşma yazıya dökülüyor. Birkaç dakika sonra sayfayı yenile.
          </span>
        </p>
      ) : captionStuck ? (
        // Düzenlenecek metin yok (caption hiç üretilmedi); boş, kilitli bir
        // alan yerine ne olduğunu ve ne yapılacağını söyle.
        <p className="p-note p-note--danger">
          <IconSparkle size={18} />
          <span>
            Caption beklenenden uzun sürdü, büyük ihtimalle hiç başlamadı. Aşağıdan yeniden üretmeyi
            dene.
          </span>
        </p>
      ) : (
        <>
          {/* Whisper sayıları yanlış duyabiliyor ("15" → "50") ve onay adımı
              yok (K33): metin sırası gelince olduğu gibi yayınlanır. Bunu
              söylemenin yeri burası. Reddedilen video yayınlanmayacağı için
              orada gürültü — kuyruğa geri alınınca yeniden çıkar. */}
          {captionReady && !rejected && (
            <p className="p-note">
              <IconSparkle size={18} />
              <span>
                Caption otomatik üretildi ve sırası gelince bu hâliyle yayınlanır.{" "}
                <strong>Sayıları ve isimleri kontrol et</strong> — konuşma yazıya dökülürken yanlış
                duyulabilir.
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
                {captionStuck
                  ? "Caption üretimi yeniden başlatılacak."
                  : "Caption baştan üretilecek; elle yaptığın değişiklikler kaybolur."}
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
                {(editable || rejected) && (
                  <button
                    type="button"
                    className="p-btn p-btn--primary p-btn--grow"
                    disabled={busy}
                    onClick={() =>
                      rejected ? void restore() : call("/to-end", {}, "Video kuyruğa geri alındı")
                    }
                  >
                    <IconUndo size={18} />
                    Kuyruğa geri al
                  </button>
                )}
              </div>
            )}
            {canRetry && props.retryNote && (
              <p className="p-hint p-hint--center">{props.retryNote}</p>
            )}
            {canRetry && (
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
