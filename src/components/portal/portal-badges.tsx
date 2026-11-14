import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";

/**
 * Portal kartının durum rozetleri. Ajans panelindeki `StatusBadge`'den ayrı:
 * orada "onay" ajans–müşteri arasındaki bir karar; portalda onay yok (K33),
 * rozetler yalnızca caption ve yayın durumunu anlatır.
 *
 * Tonlar mobil tasarımın rozetlerinden (V7): Caption hazırlanıyor → gri,
 * hata → kırmızı. Maketlerde olmayan ara durumlar (yayınlanıyor, yayınlandı)
 * en yakın tona bağlandı; yeni renk icat edilmedi.
 *
 * `status` (pending/approved/rejected) BİLEREK rozet üretmez: `approved`ı
 * tick yayından hemen önce kendisi yazıyor, K33 öncesinden kalan `rejected`
 * video da zaten "Kuyruk dışı"nda duruyor.
 */
export type BadgeInput = {
  status: PostStatus;
  captionStatus: CaptionStatus | null;
  publishStatus: PublishStatus;
};

export type BadgeTone = "navy" | "gray" | "red" | "sand";

export function portalBadges(video: BadgeInput): { label: string; tone: BadgeTone }[] {
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
  return out;
}

export function PortalBadges({
  video,
  large,
  limit,
}: {
  video: BadgeInput;
  /** Video detayının üst çubuğundaki büyük rozet. */
  large?: boolean;
  /** Dar yerde yalnızca en önemli N rozet (sıra `portalBadges`'teki önem sırası). */
  limit?: number;
}) {
  const badges = portalBadges(video);
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
