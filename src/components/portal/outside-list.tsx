"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PortalBadges, type BadgeInput } from "@/components/portal/portal-badges";
import { DeleteSheet, deleteVideo } from "@/components/portal/delete-sheet";
import { requeueVideo, restoreVideo } from "@/components/portal/requeue";
import { IconCheck, IconHourglass, IconTrash, IconUndo, IconVideo } from "@/components/portal/icons";

/** Yüzen bildirimin ekranda kalma süresi. */
export const TOAST_MS = 4_000;

export type OutsideCard = BadgeInput & {
  id: string;
  caption: string;
  coverUrl: string | null;
  /** V9: "3 gün sonra silinecek" (sunucu, müşterinin saat diliminde hesaplar). */
  deleteLabel: string | null;
  /** Son gün (yarın/bugün): sayaç koyulaşır. */
  deleteSoon: boolean;
};

/**
 * Kuyruk dışı: çıkarılan videolar (ve K33 öncesinde reddedilmiş olanlar). Kart
 * detaya gider; sağda iki düğme (V7 tasarımı, "Kuyruk dışı · geri al + sil"):
 *   • geri al — video doğrudan kuyruğun sonuna döner,
 *   • sil — kalıcı silme, onay sayfasıyla.
 * Kartın altında silme sayacı (V9, "Kuyruk dışı · silinmeye kalan gün"): kuyruk
 * dışı video 3 gün sonra kendiliğinden silinir (`media-retention.ts`).
 * İşlem biten kart hemen listeden düşer; sayfa arkadan tazelenir.
 */
export function OutsideList({ cards }: { cards: OutsideCard[] }) {
  const router = useRouter();
  const [removed, setRemoved] = useState<string[]>([]);
  const [asking, setAsking] = useState<OutsideCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Yüzen bildirim içeriği örtmesin: birkaç saniye sonra kendiliğinden gider.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const cancel = useCallback(() => {
    setAsking(null);
    setError(null);
  }, []);

  function finish(id: string, text: string) {
    setRemoved((prev) => [...prev, id]);
    setAsking(null);
    setError(null);
    setToast(text);
    router.refresh();
  }

  async function confirmDelete() {
    if (!asking || busy) return;
    setBusy(true);
    setError(null);
    const result = await deleteVideo(asking.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    finish(asking.id, "Video silindi");
  }

  async function startRestore(card: OutsideCard) {
    setToast(null);
    setError(null);
    if (busy) return;
    setBusy(true);
    // Reddedilmiş (K33 öncesi) video `to-end`den geçmez; kendi yolu var.
    const result =
      card.status === "rejected" ? await restoreVideo(card.id) : await requeueVideo(card.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    finish(card.id, "Kuyruğa geri alındı");
  }

  const visible = cards.filter((card) => !removed.includes(card.id));
  // Sayfa hatası yalnızca bir sayfa (sheet) açık DEĞİLKEN listede; açıksa orada.
  const listError = !asking ? error : null;

  return (
    <>
      {/* Bildirim bölümden BAĞIMSIZ ve yüzen (V7 tasarımı): son kart gidince
          bölüm kalkar, bildirim kalır. Birkaç saniye sonra kendiliğinden gider. */}
      {toast && (
        <p className="p-toast p-toast--float" role="status">
          <IconCheck size={18} />
          {toast}
        </p>
      )}
      {visible.length > 0 && (
        <section className="p-hgroup" aria-labelledby="kuyruk-disi">
          <div className="p-section-head">
            <h2 className="p-h2" id="kuyruk-disi">
              Kuyruk dışı
            </h2>
          </div>
          <p className="p-hint">
            Kuyruktan çıkardığın videolar yayınlanmaz ve{" "}
            <strong>3 gün sonra kendiliğinden silinir</strong>; o zamana kadar kuyruğa geri alabilirsin.
          </p>
          {listError && (
            <p className="p-error" role="alert">
              {listError}
            </p>
          )}
        <ul className="p-list" aria-label="Kuyruk dışı videolar">
          {visible.map((card) => (
            <li key={card.id} className="p-hcard p-hcard--tool">
              <Link href={`/portal/video/${card.id}`} className="p-hcard-link">
                {card.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={card.coverUrl} alt="" className="p-hcover p-cover--dim" loading="lazy" />
                ) : (
                  <span className="p-hcover p-cover--empty" aria-hidden="true">
                    <IconVideo size={20} />
                  </span>
                )}
                <span className="p-hcard-body">
                  <span className="p-qcard-meta">
                    <PortalBadges video={card} />
                  </span>
                  <span className="p-hcard-caption">{card.caption || "Caption yok"}</span>
                  {card.deleteLabel && (
                    <span className={`p-expiry${card.deleteSoon ? " p-expiry--soon" : ""}`}>
                      <IconHourglass size={13} />
                      {card.deleteLabel}
                    </span>
                  )}
                </span>
              </Link>
              <span className="p-hcard-tools">
                <button
                  type="button"
                  className="p-restore"
                  aria-label="Kuyruğa geri al"
                  disabled={busy}
                  onClick={() => void startRestore(card)}
                >
                  <IconUndo size={20} />
                </button>
                <button
                  type="button"
                  className="p-trash"
                  aria-label="Videoyu sil"
                  disabled={busy}
                  onClick={() => {
                    setToast(null);
                    setError(null);
                    setAsking(card);
                  }}
                >
                  <IconTrash size={20} />
                </button>
              </span>
            </li>
          ))}
        </ul>
        </section>
      )}
      {asking && (
        <DeleteSheet
          caption={asking.caption}
          coverUrl={asking.coverUrl}
          busy={busy}
          error={error}
          onCancel={cancel}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
