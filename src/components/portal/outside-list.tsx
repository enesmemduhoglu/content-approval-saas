"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { PortalBadges, type BadgeInput } from "@/components/portal/portal-badges";
import { DeleteSheet, deleteVideo } from "@/components/portal/delete-sheet";
import { IconCheck, IconTrash, IconVideo } from "@/components/portal/icons";

export type OutsideCard = BadgeInput & {
  id: string;
  caption: string;
  coverUrl: string | null;
};

/**
 * Kuyruk dışı: çıkarılan ve reddedilen videolar. Kart detaya gider, sağdaki
 * çöp kutusu kalıcı silmeyi açar (onay sayfasıyla). Silinen kart onaydan
 * hemen sonra listeden düşer; sayfa arkadan tazelenir.
 */
export function OutsideList({ cards, requireApproval }: { cards: OutsideCard[]; requireApproval: boolean }) {
  const router = useRouter();
  const [removed, setRemoved] = useState<string[]>([]);
  const [asking, setAsking] = useState<OutsideCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const cancel = useCallback(() => {
    setAsking(null);
    setError(null);
  }, []);

  async function confirm() {
    if (!asking || busy) return;
    setBusy(true);
    setError(null);
    const result = await deleteVideo(asking.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRemoved((prev) => [...prev, asking.id]);
    setAsking(null);
    setDone(true);
    router.refresh();
  }

  const visible = cards.filter((card) => !removed.includes(card.id));

  return (
    <>
      {done && (
        <p className="p-toast" role="status">
          <IconCheck size={18} />
          Video silindi
        </p>
      )}
      {visible.length === 0 ? (
        <p className="p-hint">Kuyruk dışında video kalmadı.</p>
      ) : (
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
                    <PortalBadges video={card} requireApproval={requireApproval} />
                  </span>
                  <span className="p-hcard-caption">{card.caption || "Caption yok"}</span>
                </span>
              </Link>
              <button
                type="button"
                className="p-trash"
                aria-label="Videoyu sil"
                onClick={() => {
                  setDone(false);
                  setAsking(card);
                }}
              >
                <IconTrash size={20} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {asking && (
        <DeleteSheet
          caption={asking.caption}
          coverUrl={asking.coverUrl}
          busy={busy}
          error={error}
          onCancel={cancel}
          onConfirm={confirm}
        />
      )}
    </>
  );
}
