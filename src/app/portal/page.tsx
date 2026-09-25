import Link from "next/link";
import type { ReactNode } from "react";
import { getClientScopedDb, type PortalVideo } from "@/lib/client-scoped-db";
import { toCard } from "@/lib/portal-media";
import { requirePortalSession } from "@/lib/portal-page";
import { getPortalContext } from "@/lib/portal-app";
import { estimatePublishTimes } from "@/lib/portal-schedule";
import { formatTime, slotDayLabel, slotWeekdayLabel } from "@/lib/portal-format";
import { PortalShell } from "@/components/portal/portal-shell";
import { QueueBoard, type QueueCard } from "@/components/portal/queue-board";
import { PortalBadges } from "@/components/portal/portal-badges";
import { InstallHint } from "@/components/portal/install-hint";
import { IconPlay } from "@/components/portal/icons";

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

/**
 * "Sıradaki yayın" kartı. Tahmin yoksa kart boş kalmıyor, NEDENİNİ söylüyor
 * (saat yok / duraklatıldı / onaylı video yok): kullanıcının kuyruk ekranında
 * ilk sorduğu soru "bir sonraki video ne zaman çıkıyor" ve "hiçbir zaman"
 * cevabının sebebi en az o kadar önemli.
 */
function NextCard({
  href,
  when,
  sub,
  small,
  thumb,
}: {
  href?: string;
  when: string;
  sub: ReactNode;
  small?: boolean;
  thumb?: { coverUrl: string | null };
}) {
  const body = (
    <>
      <span className="p-next-text">
        <span className="p-next-kicker">SIRADAKİ YAYIN</span>
        <span className={`p-next-when${small ? " p-next-when--sm" : ""}`}>{when}</span>
        <span className="p-next-sub">{sub}</span>
      </span>
      {thumb && (
        <span className="p-next-thumb" aria-hidden="true">
          {thumb.coverUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb.coverUrl} alt="" />
          )}
          <IconPlay size={22} />
        </span>
      )}
    </>
  );
  return href ? (
    <Link href={href} className="p-next">
      {body}
    </Link>
  ) : (
    <section className="p-next" aria-label="Sıradaki yayın">
      {body}
    </section>
  );
}

export default async function PortalQueuePage() {
  const session = await requirePortalSession();
  const scoped = getClientScopedDb(session);
  const [client, queue, outside, settings, { app }] = await Promise.all([
    scoped.client.get(),
    scoped.posts.listQueue(),
    scoped.posts.listOutside(),
    scoped.settings.get(),
    getPortalContext(),
  ]);
  const requireApproval = settings?.requireApproval ?? true;
  const [queueCards, outsideCards] = await Promise.all([
    cardsFor(queue, session.clientId),
    cardsFor(outside, session.clientId),
  ]);
  // Tahmin, tick'in kurallarıyla (V4 `projectSchedule`): takvimde olmayan
  // kartta hiçbir şey yazmaz — onay bekleyen video "yayınlanacak" görünmesin.
  const now = new Date();
  const timezone = settings?.timezone ?? "Europe/Istanbul";
  const etaTimes = estimatePublishTimes(queue, settings, now);
  const etas = Object.fromEntries(
    [...etaTimes].map(([id, at]) => [id, `${slotDayLabel(at, timezone, now)} ${formatTime(at, timezone)}`])
  );
  const next = [...etaTimes].sort((a, b) => a[1].getTime() - b[1].getTime())[0];
  const nextCard = next ? queueCards.find((c) => c.id === next[0]) : undefined;

  let nextView: ReactNode;
  if (!settings) {
    nextView = (
      <NextCard
        href="/portal/ayarlar"
        small
        when="Saat seçilmedi"
        sub="Yayın saatlerini kaydedince kuyruk başlar · Ayarlar"
      />
    );
  } else if (settings.paused) {
    nextView = (
      <NextCard
        href="/portal/ayarlar"
        small
        when="Duraklatıldı"
        sub="Kuyruk yerinde bekliyor · Ayarlar'dan devam ettir"
      />
    );
  } else if (next) {
    nextView = (
      <NextCard
        href={`/portal/video/${next[0]}`}
        // Gün adıyla ("Perşembe · 19:00"): yayın günleri seçiliyken sıradaki
        // yayın birkaç gün sonra olabilir; kart ritmi tek bakışta söylesin.
        when={`${slotWeekdayLabel(next[1], timezone, now)} · ${formatTime(next[1], timezone)}`}
        sub={
          requireApproval
            ? "Onaylı ilk video yayınlanır · Onay açık"
            : "Sıradaki video yayınlanır · Onay kapalı"
        }
        thumb={{ coverUrl: nextCard?.coverUrl ?? null }}
      />
    );
  } else if (queueCards.length === 0) {
    nextView = (
      <NextCard
        href="/portal/yukle"
        small
        when="Kuyruk boş"
        sub="Video yükle, sırası gelince yayınlansın"
      />
    );
  } else {
    nextView = (
      <NextCard
        small
        when={requireApproval ? "Onaylı video yok" : "Caption bekleniyor"}
        sub={
          requireApproval
            ? "Onayladığın ilk video sıradaki saatte yayınlanır"
            : "Caption'ı hazır olan ilk video sıradaki saatte yayınlanır"
        }
      />
    );
  }

  return (
    <PortalShell
      title="Kuyruk"
      brand={{ name: client?.name ?? app.name, iconSrc: `${app.iconBase}/icon-192.png` }}
    >
      {nextView}
      <InstallHint />

      <div className="p-section-head">
        <h2 className="p-h2">
          {queueCards.length > 0 ? `Sırada ${queueCards.length} video` : "Sıra"}
        </h2>
        {queueCards.length > 1 && <span className="p-hint">Oklarla sırala</span>}
      </div>
      <QueueBoard cards={queueCards} requireApproval={requireApproval} etas={etas} />

      {outsideCards.length > 0 && (
        <section className="p-hgroup" aria-labelledby="kuyruk-disi">
          <div className="p-section-head">
            <h2 className="p-h2" id="kuyruk-disi">
              Kuyruk dışı
            </h2>
          </div>
          <p className="p-hint">Kuyruktan çıkardığın ya da reddettiğin videolar. Bunlar yayınlanmaz.</p>
          <ul className="p-list">
            {outsideCards.map((card) => (
              <li key={card.id}>
                <Link href={`/portal/video/${card.id}`} className="p-hcard">
                  {card.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.coverUrl} alt="" className="p-hcover p-cover--dim" loading="lazy" />
                  ) : (
                    <span className="p-hcover p-cover--dim" aria-hidden="true" />
                  )}
                  <span className="p-hcard-body">
                    <span className="p-qcard-meta">
                      <PortalBadges video={card} requireApproval={requireApproval} />
                    </span>
                    <span className="p-hcard-caption">{card.caption || "Caption yok"}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PortalShell>
  );
}
