import Link from "next/link";
import { getClientScopedDb, type PortalVideo } from "@/lib/client-scoped-db";
import { toCard } from "@/lib/portal-media";
import { requirePortalSession } from "@/lib/portal-page";
import { estimatePublishTimes, formatEta } from "@/lib/portal-schedule";
import { PortalNav } from "@/components/portal/portal-nav";
import { QueueBoard, type QueueCard } from "@/components/portal/queue-board";
import { PortalBadges } from "@/components/portal/portal-badges";

export const dynamic = "force-dynamic";

async function cardsFor(videos: PortalVideo[], clientId: string): Promise<QueueCard[]> {
  const cards = await Promise.all(videos.map((v) => toCard(v, clientId)));
  // İstemci bileşenine yalnızca kartın ihtiyacı olan alanlar geçer.
  return cards.map((c) => ({
    id: c.id,
    caption: c.caption,
    status: c.status,
    captionStatus: c.captionStatus,
    publishStatus: c.publishStatus,
    publishError: c.publishError,
    coverUrl: c.coverUrl,
  }));
}

export default async function PortalQueuePage() {
  const session = await requirePortalSession();
  const scoped = getClientScopedDb(session);
  const [client, queue, outside, settings] = await Promise.all([
    scoped.client.get(),
    scoped.posts.listQueue(),
    scoped.posts.listOutside(),
    scoped.settings.get(),
  ]);
  const requireApproval = settings?.requireApproval ?? true;
  const [queueCards, outsideCards] = await Promise.all([
    cardsFor(queue, session.clientId),
    cardsFor(outside, session.clientId),
  ]);
  // Tahmin, tick'in kurallarıyla (V4 `projectSchedule`): takvimde olmayan
  // kartta hiçbir şey yazmaz — onay bekleyen video "yayınlanacak" görünmesin.
  const etaTimes = estimatePublishTimes(queue, settings);
  const etas = Object.fromEntries(
    [...etaTimes].map(([id, at]) => [id, `Tahmini yayın: ${formatEta(at, settings!.timezone)}`])
  );

  return (
    <>
      <PortalNav clientName={client?.name ?? "Portal"} />
      <main className="container portal-main">
        {!settings && (
          <p className="notice">
            Yayın saatlerini henüz kaydetmedin; kuyruk yayına başlamaz.{" "}
            <Link href="/portal/ayarlar">Ayarlara git</Link>
          </p>
        )}
        {settings?.paused && (
          <p className="token-alert token-alert-soon">
            Yayınlar duraklatıldı. Kuyruk yerinde duruyor; ayarlardan devam ettirebilirsin.
          </p>
        )}
        <div className="page-head">
          <h1>Kuyruk</h1>
          <Link href="/portal/yukle" className="button-primary portal-cta">
            Video yükle
          </Link>
        </div>
        <p className="settings-hint">
          {requireApproval
            ? "Yayın saatinde sıradaki ilk ONAYLI video yayınlanır."
            : "Onay kapalı: yayın saatinde sıradaki video onay beklemeden yayınlanır."}{" "}
          Sırayı sürükleyerek ya da oklarla değiştir.
        </p>
        <QueueBoard cards={queueCards} requireApproval={requireApproval} etas={etas} />

        {outsideCards.length > 0 && (
          <section className="portal-section">
            <h2>Kuyruk dışı</h2>
            <p className="settings-hint">
              Kuyruktan çıkardığın ya da reddettiğin videolar. Bunlar yayınlanmaz.
            </p>
            <ul className="post-list">
              {outsideCards.map((card) => (
                <li key={card.id} className="post-row">
                  {card.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.coverUrl} alt="" className="queue-cover" loading="lazy" />
                  ) : (
                    <span className="queue-cover queue-cover-empty" aria-hidden="true" />
                  )}
                  <div className="post-info">
                    <Link href={`/portal/video/${card.id}`}>
                      <span className="post-caption">{card.caption || "Caption yok"}</span>
                    </Link>
                    <PortalBadges video={card} requireApproval={requireApproval} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
