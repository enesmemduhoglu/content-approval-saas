import Link from "next/link";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { toCard } from "@/lib/portal-media";
import { requirePortalSession } from "@/lib/portal-page";
import { PortalNav } from "@/components/portal/portal-nav";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null, timezone: string): string {
  if (!date) return "";
  return date.toLocaleString("tr-TR", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
}

/**
 * Geçmiş: yayınlananlar (Instagram linkiyle) ve başarısızlar. Başarısız video
 * kuyrukta da "Hata" rozetiyle duruyor (README §5); burada ayrıca listelenmesi
 * "neler ters gitti" sorusunu tek yerde yanıtlamak için.
 */
export default async function PortalHistoryPage() {
  const session = await requirePortalSession();
  const scoped = getClientScopedDb(session);
  const [client, history, settings] = await Promise.all([
    scoped.client.get(),
    scoped.posts.listHistory(),
    scoped.settings.get(),
  ]);
  const timezone = settings?.timezone ?? "Europe/Istanbul";
  const cards = await Promise.all(history.map((v) => toCard(v, session.clientId)));
  const published = cards.filter((c) => c.publishStatus !== "failed");
  const failed = cards.filter((c) => c.publishStatus === "failed");

  return (
    <>
      <PortalNav clientName={client?.name ?? "Portal"} />
      <main className="container portal-main">
        <h1>Geçmiş</h1>
        {failed.length > 0 && (
          <section className="portal-section">
            <h2>Yayınlanamayanlar</h2>
            <ul className="post-list">
              {failed.map((card) => (
                <li key={card.id} className="post-row">
                  {card.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.coverUrl} alt="" className="queue-cover" loading="lazy" />
                  ) : (
                    <span className="queue-cover queue-cover-empty" aria-hidden="true" />
                  )}
                  <div className="post-info">
                    <span className="post-caption">{card.caption}</span>
                    {card.publishError && <p className="rejection-reason">{card.publishError}</p>}
                    <Link href={`/portal/video/${card.id}`}>Tekrar dene ya da sona at</Link>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="portal-section">
          <h2>Yayınlananlar</h2>
          {published.length === 0 ? (
            <p className="empty-state">Henüz yayınlanan video yok.</p>
          ) : (
            <ul className="post-list">
              {published.map((card) => (
                <li key={card.id} className="post-row">
                  {card.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.coverUrl} alt="" className="queue-cover" loading="lazy" />
                  ) : (
                    <span className="queue-cover queue-cover-empty" aria-hidden="true" />
                  )}
                  <div className="post-info">
                    <span className="post-caption">{card.caption}</span>
                    <p className="post-date">{formatDate(card.publishedAt, timezone)}</p>
                    {card.igPermalink && (
                      <a href={card.igPermalink} target="_blank" rel="noreferrer">
                        Instagram&apos;da gör
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
