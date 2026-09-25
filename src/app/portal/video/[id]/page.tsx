import Link from "next/link";
import { notFound } from "next/navigation";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { toDetail } from "@/lib/portal-media";
import { requirePortalSession } from "@/lib/portal-page";
import { PortalNav } from "@/components/portal/portal-nav";
import { PortalBadges } from "@/components/portal/portal-badges";
import { VideoActions } from "@/components/portal/video-actions";

export const dynamic = "force-dynamic";

export default async function PortalVideoPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePortalSession();
  const { id } = await params;
  const scoped = getClientScopedDb(session);
  const [client, video, settings] = await Promise.all([
    scoped.client.get(),
    scoped.posts.findById(id),
    scoped.settings.get(),
  ]);
  // Başka müşterinin videosu da "yok": kapsamlı sorgu satırı hiç döndürmez.
  if (!video || video.status === "draft") notFound();
  const detail = await toDetail(video, session.clientId);
  const requireApproval = settings?.requireApproval ?? true;

  return (
    <>
      <PortalNav clientName={client?.name ?? "Portal"} />
      <main className="container portal-main portal-video">
        <p>
          <Link href="/portal">← Kuyruğa dön</Link>
        </p>
        {detail.videoUrl ? (
          // `autoPlay` yok: sayfa açılır açılmaz ses çalmasın (onay sayfasıyla aynı karar).
          <video
            src={detail.videoUrl}
            poster={detail.coverUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="approve-image approve-video"
            aria-label="Video önizlemesi"
          />
        ) : (
          <p className="notice">Video şu an gösterilemiyor (depolama bağlantısı yok).</p>
        )}
        <div className="video-meta">
          <PortalBadges video={detail} requireApproval={requireApproval} />
          {detail.status === "rejected" && detail.rejectionReason && (
            <p className="rejection-reason">Red nedeni: {detail.rejectionReason}</p>
          )}
          {detail.publishStatus === "failed" && detail.publishError && (
            <p className="rejection-reason">Yayın hatası: {detail.publishError}</p>
          )}
          {detail.captionStatus === "failed" && detail.captionError && (
            <p className="rejection-reason">Caption üretilemedi: {detail.captionError}</p>
          )}
          {detail.igPermalink && (
            <a href={detail.igPermalink} target="_blank" rel="noreferrer" className="button-secondary">
              Instagram&apos;da gör
            </a>
          )}
        </div>
        <VideoActions
          id={detail.id}
          caption={detail.caption}
          status={detail.status}
          captionStatus={detail.captionStatus}
          publishStatus={detail.publishStatus}
          inQueue={detail.queuePosition !== null}
          requireApproval={requireApproval}
        />
      </main>
    </>
  );
}
