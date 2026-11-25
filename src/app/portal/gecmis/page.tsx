import Link from "next/link";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { toCard, type PortalVideoCard } from "@/lib/portal-media";
import { toAdCards } from "@/lib/portal-ads";
import { requirePortalSession } from "@/lib/portal-page";
import { historyGroup, shortDateTime } from "@/lib/portal-format";
import { adPublishErrorTitle, explainPublishError } from "@/lib/portal-publish-error";
import { PortalShell } from "@/components/portal/portal-shell";
import { HistoryTabs } from "@/components/portal/history-tabs";
import { IconChevronRight, IconClock, IconExternal, IconVideo } from "@/components/portal/icons";
import { calendarDaysUntil, videoStaysLabel } from "@/lib/retention-rules";

export const dynamic = "force-dynamic";

/**
 * Geçmişin satırı: video kartı ya da (V12b) reklam görseli. Reklam ayrı bir
 * sekmede değil, yayınlandığı yerde: kullanıcı profilinde gördüğü sırayı
 * burada da görsün. Reklamın dosyası silinmediği için "N gün daha" notu yok.
 */
type HistoryCard = Pick<
  PortalVideoCard,
  "id" | "caption" | "coverUrl" | "publishedAt" | "igPermalink" | "publishError" | "slotAt" | "updatedAt"
> & { videoKeptUntil: Date | null; isAd: boolean; failed: boolean };

function Cover({ card }: { card: HistoryCard }) {
  return card.coverUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={card.coverUrl} alt="" className="p-hcover" loading="lazy" />
  ) : (
    <span className="p-hcover p-cover--empty" aria-hidden="true">
      <IconVideo size={20} />
    </span>
  );
}

/** Kartları "BU HAFTA / GEÇEN HAFTA / EYLÜL 2026" başlıkları altında, sıra korunarak gruplar. */
function grouped(
  cards: HistoryCard[],
  dateOf: (card: HistoryCard) => Date | null,
  timezone: string,
  now: Date
): { label: string; cards: HistoryCard[] }[] {
  const out: { label: string; cards: HistoryCard[] }[] = [];
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
  const [history, settings, adRows] = await Promise.all([
    scoped.posts.listHistory(),
    scoped.settings.get(),
    scoped.ads.list(),
  ]);
  const timezone = settings?.timezone ?? "Europe/Istanbul";
  const now = new Date();
  const videoCards: HistoryCard[] = (
    await Promise.all(history.map((v) => toCard(v, session.clientId)))
  ).map((c) => ({ ...c, isAd: false, failed: c.publishStatus === "failed" }));
  const ads = await toAdCards(adRows, session.clientId);
  // Reklam listesi `updatedAt` taşımıyor; hata alan reklamın tarihi yükleme anı.
  const createdById = new Map(adRows.map((row) => [row.id, row.createdAt]));
  const adCards: HistoryCard[] = [...ads.published, ...ads.pool.filter((c) => c.state === "failed")].map(
    (c) => ({
      id: c.id,
      caption: c.caption,
      coverUrl: c.coverUrl,
      publishedAt: c.publishedAt,
      igPermalink: c.igPermalink,
      publishError: c.publishError,
      slotAt: null,
      updatedAt: createdById.get(c.id) ?? now,
      videoKeptUntil: null,
      isAd: true,
      failed: c.state === "failed",
    })
  );
  // Başarısız videonun yayın tarihi yok; denendiği slot, o da yoksa son değişiklik.
  const failedAt = (c: HistoryCard) => c.slotAt ?? c.updatedAt;
  const byDateDesc = (dateOf: (c: HistoryCard) => Date | null) => (a: HistoryCard, b: HistoryCard) =>
    (dateOf(b)?.getTime() ?? 0) - (dateOf(a)?.getTime() ?? 0);
  const all = [...videoCards, ...adCards];
  const published = all.filter((c) => !c.failed).sort(byDateDesc((c) => c.publishedAt));
  const failed = all.filter((c) => c.failed).sort(byDateDesc(failedAt));

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
                  <span className="p-hcard-caption">
                    {card.isAd && <span className="p-badge p-badge--sand">Reklam</span>}{" "}
                    {card.caption || "Caption yok"}
                  </span>
                  {card.videoKeptUntil && (
                    // V9: video yayından 2 gün sonra R2'den kalkar; kapak kalır.
                    <span className="p-hcard-stays">
                      <IconClock size={12} />
                      {videoStaysLabel(calendarDaysUntil(card.videoKeptUntil, now, timezone))}
                    </span>
                  )}
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
                <Link
                  // Reklamın detay sayfası yok; tekrar dene havuz ekranında.
                  href={card.isAd ? "/portal/reklamlar" : `/portal/video/${card.id}`}
                  className="p-hcard p-hcard--failed"
                >
                  <Cover card={card} />
                  <span className="p-hcard-body">
                    <span className="p-hcard-date">{shortDateTime(failedAt(card), timezone)}</span>
                    <span className="p-hcard-caption">
                      {card.isAd && <span className="p-badge p-badge--sand">Reklam</span>}{" "}
                      {card.caption || "Caption yok"}
                    </span>
                    <span className="p-hcard-error">
                      {card.isAd
                        ? adPublishErrorTitle(card.publishError)
                        : explainPublishError(card.publishError).title}
                    </span>
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
