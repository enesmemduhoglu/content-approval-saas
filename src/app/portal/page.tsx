import Link from "next/link";
import type { ReactNode } from "react";
import { getClientScopedDb, type PortalVideo } from "@/lib/client-scoped-db";
import { toCard } from "@/lib/portal-media";
import { requirePortalSession } from "@/lib/portal-page";
import { getPortalContext } from "@/lib/portal-app";
import { estimatePublishTimes, queueRunway } from "@/lib/portal-schedule";
import {
  formatTime,
  runwaySummary,
  slotDayLabel,
  slotWeekdayLabel,
  type RunwaySummary,
} from "@/lib/portal-format";
import { PortalShell } from "@/components/portal/portal-shell";
import { QueueBoard, type QueueCard } from "@/components/portal/queue-board";
import { OutsideList } from "@/components/portal/outside-list";
import { InstallHint } from "@/components/portal/install-hint";
import { IconPlay } from "@/components/portal/icons";

export const dynamic = "force-dynamic";

async function cardsFor(
  videos: PortalVideo[],
  clientId: string
): Promise<(QueueCard & { rejectionReason: string | null })[]> {
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
    rejectionReason: c.rejectionReason,
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
  runway,
}: {
  href?: string;
  when: string;
  sub: ReactNode;
  small?: boolean;
  thumb?: { coverUrl: string | null };
  runway?: RunwayRow;
}) {
  const body = (
    <>
      <span className="p-next-row">
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
      </span>
      {runway && <RunwayLine {...runway} />}
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

type RunwayRow = Pick<RunwaySummary, "headline" | "level"> & { sub?: string; extra?: string };

/**
 * "Kuyruk kaç gün yeter" — sıradaki yayın kartının alt satırı (V7 tasarımı,
 * varyant B). Ana rakam onaylı videolarla (gerçekten yayınlanacaklar); onay
 * bekleyenler takvimi uzatıyorsa sağda "Hepsini onaylarsan X gün".
 */
function RunwayLine({ headline, sub, extra, level }: RunwayRow) {
  return (
    <span className={`p-next-runway${level === "low" ? " p-next-runway--low" : ""}`}>
      <span className="p-next-runway-main">
        <span className="p-next-kicker">KUYRUK</span>
        <span className="p-next-runway-head">{headline}</span>
        {sub && <span className="p-next-runway-sub">{sub}</span>}
      </span>
      {extra && <span className="p-next-runway-extra">{extra}</span>}
    </span>
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
  // Aynı `now`: gösterge ile "Sıradaki yayın" aynı anı baz alsın.
  const runway = runwaySummary(queueRunway(queue, settings, now), timezone, now);

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
        runway={runway && runway.level !== "empty" ? runway : undefined}
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
        // Başlık zaten "Onaylı video yok" diyor; gösterge yalnızca onaylanırsa
        // kuyruğun ne kadar yeteceğini ekler.
        runway={runway?.extra ? { headline: runway.extra, level: "ok" } : undefined}
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

      {/* Bölüm başlığı listenin içinde: son kart da gidince bölüm kalkar ama
          "Video silindi" bildirimi (bileşenin durumu) yerinde kalır. Eskiden
          bölüm burada koşullu çiziliyordu ve bildirim bölümle birlikte gidiyordu. */}
      <OutsideList cards={outsideCards} requireApproval={requireApproval} />
    </PortalShell>
  );
}
