import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";

/**
 * Portal kartının durum rozetleri. Ajans panelindeki `StatusBadge`'den ayrı:
 * orada "onay" ajans–müşteri arasındaki bir karar, burada müşterinin kendi
 * kuyruğundaki bir kapı.
 *
 * Tonlar mobil tasarımın dört rozetinden (V7): Onaylı → lacivert dolgu, Onay
 * bekliyor → şeftali, Caption hazırlanıyor → gri, hata/red → kırmızı.
 * Maketlerde olmayan ara durumlar (yayınlanıyor, yayınlandı) en yakın tona
 * bağlandı; yeni renk icat edilmedi.
 *
 * Onay kapalıyken (`requireApproval = false`) "Onay bekliyor" GÖSTERİLMEZ:
 * video onay beklemeden yayınlanacak, rozet kullanıcıyı yanıltırdı.
 */
export type BadgeInput = {
  status: PostStatus;
  captionStatus: CaptionStatus | null;
  publishStatus: PublishStatus;
};

export type BadgeTone = "navy" | "peach" | "gray" | "red" | "sand";

export function portalBadges(
  video: BadgeInput,
  requireApproval: boolean
): { label: string; tone: BadgeTone }[] {
  const out: { label: string; tone: BadgeTone }[] = [];
  if (video.publishStatus === "failed") out.push({ label: "Yayınlanamadı", tone: "red" });
  if (video.publishStatus === "publishing") out.push({ label: "Yayınlanıyor", tone: "sand" });
  if (video.publishStatus === "published" || video.publishStatus === "duplicate") {
    out.push({ label: "Yayınlandı", tone: "navy" });
  }
  if (video.captionStatus === "pending" || video.captionStatus === "generating") {
    out.push({ label: "Caption hazırlanıyor", tone: "gray" });
  } else if (video.captionStatus === "failed") {
    out.push({ label: "Caption üretilemedi", tone: "red" });
  }
  if (video.status === "rejected") out.push({ label: "Reddedildi", tone: "red" });
  // Yayın hatası rozeti zaten kartın rengini ve dikkatini taşıyor; yanına
  // "Onaylı" eklemek maketteki tek rozetli hata kartını ikiye bölüyordu.
  if (
    video.status === "approved" &&
    video.publishStatus !== "published" &&
    video.publishStatus !== "failed"
  ) {
    out.push({ label: "Onaylı", tone: "navy" });
  }
  if (video.status === "pending" && requireApproval && video.captionStatus === "ready") {
    out.push({ label: "Onay bekliyor", tone: "peach" });
  }
  return out;
}

export function PortalBadges({
  video,
  requireApproval,
  large,
  limit,
}: {
  video: BadgeInput;
  requireApproval: boolean;
  /** Video detayının üst çubuğundaki büyük rozet. */
  large?: boolean;
  /** Dar yerde yalnızca en önemli N rozet (sıra `portalBadges`'teki önem sırası). */
  limit?: number;
}) {
  const badges = portalBadges(video, requireApproval);
  return (
    <>
      {(limit ? badges.slice(0, limit) : badges).map((badge) => (
        <span key={badge.label} className={`p-badge p-badge--${badge.tone}${large ? " p-badge--lg" : ""}`}>
          {badge.label}
        </span>
      ))}
    </>
  );
}
