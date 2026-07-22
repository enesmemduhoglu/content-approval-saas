import type { PostStatus } from "@prisma/client";

const LABELS: Record<PostStatus, string> = {
  draft: "Taslak",
  pending: "Onay bekliyor",
  approved: "Onaylandı",
  rejected: "Reddedildi",
};

export function StatusBadge({ status }: { status: PostStatus }) {
  return <span className={`status-badge status-${status}`}>{LABELS[status]}</span>;
}
