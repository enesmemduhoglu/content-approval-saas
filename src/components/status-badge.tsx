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
  // Aynı externalRef'li kardeş post hâlâ canlıdaydı, yayın atlandı. "Yayınlanamadı"
  // demek yanıltıcı olur — ortada hata yok, içerik zaten yerinde.
  duplicate: "Zaten yayında",
  // F8: onaylandı, publishAt gelecekte — yayın crona bırakıldı. "Yayınlanmadı"
  // (awaitingPublish'in idle etiketi) DEĞİL: o "unutulmuş" çağrışımı yapar,
  // burada her şey planlandığı gibi bekliyor.
  scheduled: "Zamanlandı",
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

/**
 * Onay e-postasının akıbeti (F5).
 *
 * Diğer rozetlerin aksine BAŞARIYI DA gösterir. Sebep: bu rozetin var olma
 * sebebi "mail gitti mi" sorusunun panelden yanıtlanamamasıydı; başarıda sessiz
 * kalsaydı "gitti" ile "hiç denenmedi" yine ayırt edilemezdi — yani sorun
 * çözülmemiş olurdu. `null` (eski postlar, alan eklenmeden önce oluşmuş)
 * bilerek sessiz: onlar için gerçekten bilmiyoruz, uydurmak yanlış olur.
 */
export function EmailBadge({ sent }: { sent: boolean | null }) {
  if (sent === null) return null;
  return sent ? (
    <span className="status-badge email-sent">Mail gitti</span>
  ) : (
    <span className="status-badge email-failed">Mail GİTMEDİ</span>
  );
}
