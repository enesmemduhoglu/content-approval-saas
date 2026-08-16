import type { PostStatus, PublishStatus } from "@prisma/client";

const LABELS: Record<PostStatus, string> = {
  draft: "Taslak",
  pending: "Onay bekliyor",
  approved: "Onaylandı",
  rejected: "Reddedildi",
};

export function StatusBadge({ status }: { status: PostStatus }) {
  return <span className={`status-badge status-${status}`}>{LABELS[status]}</span>;
}

/**
 * Onay ≠ yayın. Bu rozet yalnızca Instagram tarafında bir şey OLDUĞUNDA çıkar:
 * "idle" (yayın hedefi yok) ve "skipped" (müşteride Instagram bağlı değil)
 * hiçbir şey göstermez — Instagram kullanmayan ajansların paneli aynı kalır.
 *
 * Tek istisna `awaitingPublish`: post onaylanmış, müşteride Instagram bağlı ama
 * publishStatus hâlâ "idle" — yani yayın hiç denenmemiş. Sessiz kalmaması
 * gereken durum bu (eski toplu onaylardan kalan postlar da böyle).
 */
const PUBLISH_LABELS: Partial<Record<PublishStatus, string>> = {
  publishing: "Yayınlanıyor",
  published: "Instagram'da",
  failed: "Yayınlanamadı",
};

export function PublishBadge({
  status,
  awaitingPublish = false,
}: {
  status: PublishStatus;
  awaitingPublish?: boolean;
}) {
  if (status === "idle" && awaitingPublish) {
    return <span className="status-badge publish-idle">Yayınlanmadı</span>;
  }
  const label = PUBLISH_LABELS[status];
  if (!label) return null;
  return <span className={`status-badge publish-${status}`}>{label}</span>;
}
