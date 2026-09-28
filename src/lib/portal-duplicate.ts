/**
 * "Aynı video" uyarısı (2026-09-28 analizi) — sunucu yanıtının tipi ve
 * kartta görünen metinler. Sunucu (`api/portal/upload/check`) ve istemci
 * (`use-video-upload`) aynı tipi paylaşır.
 */

export type DuplicateWhere = "queue" | "outside" | "rejected" | "published";

export type DuplicateMatch = {
  id: string;
  /** ISO. */
  createdAt: string;
  where: DuplicateWhere;
  /** Kuyruktaysa 1'den başlayan sırası. */
  position: number | null;
};

/** Eşin yeri, bağlantı metni olarak: "Kuyrukta 3." */
export function duplicatePlace(match: DuplicateMatch): string {
  switch (match.where) {
    case "queue":
      return match.position ? `Kuyrukta ${match.position}.` : "Kuyrukta";
    case "outside":
      return "Kuyruk dışında";
    case "rejected":
      return "Reddedilmişti";
    case "published":
      return "Yayınlandı";
  }
}

/** Uyarının gövdesi: "Aynı boyutta bir video 26 Eylül tarihinde yüklenmiş". */
export function duplicateSentence(match: DuplicateMatch, timezone = "Europe/Istanbul"): string {
  const date = new Date(match.createdAt).toLocaleDateString("tr-TR", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
  });
  return `Aynı boyutta bir video ${date} tarihinde yüklenmiş`;
}

/** Atlanan kartın satırı: "Yüklenmedi · zaten kuyrukta". */
export function skippedText(match: DuplicateMatch): string {
  switch (match.where) {
    case "queue":
      return "Yüklenmedi · zaten kuyrukta";
    case "outside":
      return "Yüklenmedi · zaten yüklü (kuyruk dışında)";
    case "rejected":
      return "Yüklenmedi · daha önce reddedilmişti";
    case "published":
      return "Yüklenmedi · zaten yayınlandı";
  }
}
