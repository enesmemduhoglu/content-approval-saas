import Link from "next/link";
import { notFound } from "next/navigation";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { toDetail } from "@/lib/portal-media";
import { requirePortalSession } from "@/lib/portal-page";
import { estimateIfApproved, estimatePublishTimes } from "@/lib/portal-schedule";
import { shortDateTime, slotLabel } from "@/lib/portal-format";
import { PortalBadges } from "@/components/portal/portal-badges";
import { VideoActions } from "@/components/portal/video-actions";
import { PublishErrorCard } from "@/components/portal/publish-error-card";
import { explainPublishError } from "@/lib/portal-publish-error";
import { reviewNext } from "@/lib/portal-review";
import { isInstagramBlocked } from "@/lib/portal-instagram";
import { IconChevronLeft, IconExternal } from "@/components/portal/icons";

export const dynamic = "force-dynamic";

export default async function PortalVideoPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePortalSession();
  const { id } = await params;
  const scoped = getClientScopedDb(session);
  const now = new Date();
  const [video, settings, queue, instagram] = await Promise.all([
    scoped.posts.findById(id),
    scoped.settings.get(),
    scoped.posts.listQueue(),
    scoped.client.instagramHealth(now),
  ]);
  // Başka müşterinin videosu da "yok": kapsamlı sorgu satırı hiç döndürmez.
  if (!video || video.status === "draft") notFound();
  const detail = await toDetail(video, session.clientId);
  const requireApproval = settings?.requireApproval ?? true;
  const timezone = settings?.timezone ?? "Europe/Istanbul";

  // Yayın satırı: kuyruk ekranıyla AYNI tahmin (`projectSchedule`). Takvimde
  // yoksa saat uydurulmuyor, nedeni yazılıyor. Instagram bağlantısı yoksa
  // tick slotları boş geçiyor: saat yazmak yalan olur (kuyruk ekranıyla aynı).
  const blocked = isInstagramBlocked(instagram);
  const eta = blocked ? undefined : estimatePublishTimes(queue, settings, now).get(detail.id);
  const position = queue.findIndex((v) => v.id === detail.id);
  const inQueue = detail.queuePosition !== null;
  const captionBusy = detail.captionStatus === "pending" || detail.captionStatus === "generating";
  const publishError =
    detail.publishStatus === "failed" ? explainPublishError(detail.publishError) : null;

  let kicker = "YAYIN";
  let when: string;
  if (detail.publishStatus === "published" || detail.publishStatus === "duplicate") {
    kicker = "YAYINLANDI";
    when = detail.publishedAt ? shortDateTime(detail.publishedAt, timezone) : "Instagram'da";
  } else if (detail.publishStatus === "publishing") {
    when = "Şu an yayınlanıyor";
  } else if (detail.status === "rejected") {
    when = "Reddedildi · yayınlanmaz";
  } else if (detail.publishStatus === "failed" && inQueue) {
    // Başarısız video tick'te kendiliğinden yeniden denenmez; "Tekrar dene" bekler.
    when = "Tekrar denemeni bekliyor";
  } else if (!inQueue) {
    when = "Kuyruk dışında";
  } else if (blocked) {
    when = "Instagram bağlantısı bekleniyor";
  } else if (eta) {
    when = slotLabel(eta, timezone, now);
  } else if (!settings) {
    when = "Yayın saati seçilmedi";
  } else if (settings.paused) {
    when = "Yayınlar duraklatıldı";
  } else if (captionBusy) {
    when = "Caption hazır olunca takvime girer";
  } else if (detail.status === "pending" && requireApproval) {
    // V7 tasarımı: "Onaylarsan 27 Eyl · 19:00" — yalnızca bu video onaylansa.
    const ifApproved = estimateIfApproved(queue, settings, now).get(detail.id);
    when = ifApproved ? `Onaylarsan ${slotLabel(ifApproved, timezone, now)}` : "Onaylayınca takvime girer";
  } else {
    when = "Takvimde değil";
  }

  return (
    <main className="p-page p-page--detail">
      <div className="p-detail-top">
        <Link href="/portal" className="p-back">
          <IconChevronLeft size={20} />
          Kuyruk
        </Link>
        <span className="p-badges">
          <PortalBadges video={detail} requireApproval={requireApproval} large limit={1} />
        </span>
      </div>

      <div className="p-detail-body">
        <h1 className="sr-only">Video detayı</h1>
        <div className="p-player">
          {detail.videoUrl ? (
            // `autoPlay` yok: sayfa açılır açılmaz ses çalmasın (onay sayfasıyla aynı karar).
            <video
              src={detail.videoUrl}
              poster={detail.coverUrl ?? undefined}
              controls
              playsInline
              preload="metadata"
              aria-label="Video önizlemesi"
            />
          ) : (
            <p className="p-player-empty">Video şu an gösterilemiyor (depolama bağlantısı yok).</p>
          )}
        </div>

        <div className="p-when">
          <div className="p-when-text">
            <span className="p-kicker p-kicker--accent">{kicker}</span>
            <span className="p-when-value">{when}</span>
          </div>
          {position >= 0 && <span className="p-when-side">Sırada {position + 1}.</span>}
        </div>

        {detail.status === "rejected" && detail.rejectionReason && (
          <p className="p-note p-note--danger">Red nedeni: {detail.rejectionReason}</p>
        )}
        {publishError && <PublishErrorCard error={publishError} />}
        {detail.captionStatus === "failed" && detail.captionError && (
          <p className="p-note p-note--danger">Caption üretilemedi: {detail.captionError}</p>
        )}
        {detail.igPermalink && (
          // Ana ekran uygulamasında `_blank` Instagram uygulamasına/Safari'ye
          // çıkar; portal penceresi yerinde kalır (V7-pwa §4.4).
          <a href={detail.igPermalink} target="_blank" rel="noopener noreferrer" className="p-ig-link">
            Instagram&apos;da gör
            <IconExternal size={16} />
          </a>
        )}

        <VideoActions
          id={detail.id}
          caption={detail.caption}
          status={detail.status}
          captionStatus={detail.captionStatus}
          publishStatus={detail.publishStatus}
          inQueue={inQueue}
          requireApproval={requireApproval}
          review={requireApproval ? reviewNext(queue, detail.id) : undefined}
          retryNote={
            publishError?.retryUseless
              ? "Aynı dosyayla tekrar denemek büyük ihtimalle yine başarısız olur."
              : undefined
          }
          canDelete={
            !inQueue &&
            detail.status !== "draft" &&
            (detail.publishStatus === "idle" || detail.publishStatus === "failed")
          }
        />
      </div>
    </main>
  );
}
