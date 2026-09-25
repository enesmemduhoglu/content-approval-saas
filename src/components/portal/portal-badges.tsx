import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";

/**
 * Portal kartının durum rozetleri. Ajans panelindeki `StatusBadge`'den ayrı:
 * orada "onay" ajans–müşteri arasındaki bir karar, burada müşterinin kendi
 * kuyruğundaki bir kapı. Aynı sınıf adları (`status-*`) kullanılıyor ki görsel
 * dil ortak kalsın.
 *
 * Onay kapalıyken (`requireApproval = false`) "Onay bekliyor" GÖSTERİLMEZ:
 * video onay beklemeden yayınlanacak, rozet kullanıcıyı yanıltırdı.
 */
export type BadgeInput = {
  status: PostStatus;
  captionStatus: CaptionStatus | null;
  publishStatus: PublishStatus;
};

export function portalBadges(
  video: BadgeInput,
  requireApproval: boolean
): { label: string; tone: string }[] {
  const out: { label: string; tone: string }[] = [];
  if (video.publishStatus === "failed") out.push({ label: "Hata", tone: "status-rejected" });
  if (video.publishStatus === "publishing") out.push({ label: "Yayınlanıyor", tone: "status-pending" });
  if (video.publishStatus === "published" || video.publishStatus === "duplicate") {
    out.push({ label: "Yayınlandı", tone: "status-approved" });
  }
  if (video.captionStatus === "pending" || video.captionStatus === "generating") {
    out.push({ label: "Caption hazırlanıyor", tone: "status-draft" });
  } else if (video.captionStatus === "failed") {
    out.push({ label: "Caption üretilemedi", tone: "status-rejected" });
  }
  if (video.status === "rejected") out.push({ label: "Reddedildi", tone: "status-rejected" });
  if (video.status === "approved" && video.publishStatus !== "published") {
    out.push({ label: "Onaylı", tone: "status-approved" });
  }
  if (video.status === "pending" && requireApproval && video.captionStatus === "ready") {
    out.push({ label: "Onay bekliyor", tone: "status-pending" });
  }
  return out;
}

export function PortalBadges({
  video,
  requireApproval,
}: {
  video: BadgeInput;
  requireApproval: boolean;
}) {
  return (
    <span className="portal-badges">
      {portalBadges(video, requireApproval).map((badge) => (
        <span key={badge.label} className={`status-badge ${badge.tone}`}>
          {badge.label}
        </span>
      ))}
    </span>
  );
}
