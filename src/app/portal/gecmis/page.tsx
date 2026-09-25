import Link from "next/link";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { toCard, type PortalVideoCard } from "@/lib/portal-media";
import { requirePortalSession } from "@/lib/portal-page";
import { historyGroup, shortDateTime } from "@/lib/portal-format";
import { PortalShell } from "@/components/portal/portal-shell";
import { HistoryTabs } from "@/components/portal/history-tabs";
import { IconChevronRight, IconExternal } from "@/components/portal/icons";

export const dynamic = "force-dynamic";

function Cover({ card }: { card: PortalVideoCard }) {
  return card.coverUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={card.coverUrl} alt="" className="p-hcover" loading="lazy" />
  ) : (
    <span className="p-hcover" aria-hidden="true" />
  );
}

/** Kartları "BU HAFTA / GEÇEN HAFTA / EYLÜL 2026" başlıkları altında, sıra korunarak gruplar. */
function grouped(
  cards: PortalVideoCard[],
  dateOf: (card: PortalVideoCard) => Date | null,
  timezone: string,
  now: Date
): { label: string; cards: PortalVideoCard[] }[] {
  const out: { label: string; cards: PortalVideoCard[] }[] = [];
  for (const card of cards) {
    const at = dateOf(card);
    const label = at ? historyGroup(at, timezone, now) : "TARİHSİZ";
    const last = out[out.length - 1];
    if (last && last.label === label) last.cards.push(card);
    else out.push({ label, cards: [card] });
  }
  return out;
}

/**
 * Geçmiş: yayınlananlar (Instagram linkiyle) ve başarısızlar. Başarısız video
 * kuyrukta da "Yayınlanamadı" rozetiyle duruyor (README §5); burada ayrıca
 * listelenmesi "neler ters gitti" sorusunu tek yerde yanıtlamak için.
 */
export default async function PortalHistoryPage() {
  const session = await requirePortalSession();
  const scoped = getClientScopedDb(session);
  const [history, settings] = await Promise.all([scoped.posts.listHistory(), scoped.settings.get()]);
  const timezone = settings?.timezone ?? "Europe/Istanbul";
  const now = new Date();
  const cards = await Promise.all(history.map((v) => toCard(v, session.clientId)));
  const published = cards.filter((c) => c.publishStatus !== "failed");
  const failed = cards.filter((c) => c.publishStatus === "failed");
  // Başarısız videonun yayın tarihi yok; denendiği slot, o da yoksa son değişiklik.
  const failedAt = (c: PortalVideoCard) => c.slotAt ?? c.updatedAt;

  const publishedPanel =
    published.length === 0 ? (
      <p className="p-empty">Henüz yayınlanan video yok.</p>
    ) : (
      grouped(published, (c) => c.publishedAt, timezone, now).map((group) => (
        <section key={group.label} className="p-hgroup" aria-label={group.label}>
          <h2 className="p-kicker">{group.label}</h2>
          <ul className="p-list">
            {group.cards.map((card) => (
              <li key={card.id} className="p-hcard">
                <Cover card={card} />
                <div className="p-hcard-body">
                  {card.publishedAt && (
                    <span className="p-hcard-date">{shortDateTime(card.publishedAt, timezone)}</span>
                  )}
                  <span className="p-hcard-caption">{card.caption || "Caption yok"}</span>
                </div>
                {card.igPermalink && (
                  // Ana ekran uygulamasında `_blank` Instagram'a çıkar, portal yerinde kalır.
                  <a
                    href={card.igPermalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-square-link"
                    aria-label="Instagram'da aç"
                  >
                    <IconExternal size={18} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))
    );

  const failedPanel =
    failed.length === 0 ? (
      <p className="p-empty">Yayınlanamayan video yok.</p>
    ) : (
      grouped(failed, failedAt, timezone, now).map((group) => (
        <section key={group.label} className="p-hgroup" aria-label={group.label}>
          <h2 className="p-kicker">{group.label}</h2>
          <ul className="p-list">
            {group.cards.map((card) => (
              <li key={card.id}>
                <Link href={`/portal/video/${card.id}`} className="p-hcard p-hcard--failed">
                  <Cover card={card} />
                  <span className="p-hcard-body">
                    <span className="p-hcard-date">{shortDateTime(failedAt(card), timezone)}</span>
                    <span className="p-hcard-caption">{card.caption || "Caption yok"}</span>
                    {card.publishError && <span className="p-hcard-error">{card.publishError}</span>}
                    <span className="sr-only">Tekrar dene ya da sona at</span>
                  </span>
                  <span className="p-square-link" aria-hidden="true">
                    <IconChevronRight size={18} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))
    );

  return (
    <PortalShell title="Geçmiş">
      <HistoryTabs
        publishedCount={published.length}
        failedCount={failed.length}
        published={publishedPanel}
        failed={failedPanel}
      />
    </PortalShell>
  );
}
