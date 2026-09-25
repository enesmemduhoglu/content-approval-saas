import { captionHead, type SlotEmptyReason } from "@/lib/email-queue";
import type { PushPayload } from "@/lib/push";

/**
 * V7c — olay başına bildirim metinleri (V7-pwa §6.1 tablosu). Saf: kancalar
 * (`publish-post`, tick, `queue-digest`) yalnızca veriyi verir, metin burada.
 * E-posta metinleriyle aynı dil ama kısa: kilit ekranında iki satır görünür.
 *
 * Payload'a sır, token ya da imzalı URL girmez: caption'ın ilk satırı, saat
 * ve `safeReason`'dan geçmiş hata metni. Linkler portal içi yol ya da
 * Instagram permalink'i (`push.ts > safePushUrl` ikinci kez süzer).
 */

function formatTime(at: Date, timeZone: string): string {
  return at.toLocaleTimeString("tr-TR", { timeZone, hour: "2-digit", minute: "2-digit" });
}

export function publishedPush(input: { caption: string; igPermalink: string | null }): PushPayload {
  return {
    title: "Videon yayınlandı",
    body: captionHead(input.caption, 90) || "Instagram'da görmek için dokun.",
    // Permalink yoksa (Instagram döndürmediyse) geçmiş sayfası.
    url: input.igPermalink ?? "/portal/gecmis",
    tag: "yayin-sonucu",
  };
}

/** `reason` çağıranda `safeReason`'dan geçmiş olmalı (imzalı URL/token ayıklanmış). */
export function failedPush(input: { postId: string; reason: string | null }): PushPayload {
  return {
    title: "Video yayınlanamadı",
    body: input.reason ? `Neden: ${input.reason}` : "Ayrıntı için dokun.",
    url: `/portal/video/${encodeURIComponent(input.postId)}`,
    tag: "yayin-sonucu",
  };
}

export function slotEmptyPush(input: {
  slotAt: Date;
  timezone: string;
  reason: SlotEmptyReason;
  pendingCount?: number;
}): PushPayload {
  const at = formatTime(input.slotAt, input.timezone);
  if (input.reason === "no_approved") {
    return {
      title: "Bu saatte onaylı video yoktu",
      body:
        input.pendingCount && input.pendingCount > 0
          ? `${at} yayını yapılmadı. ${input.pendingCount} video onayını bekliyor.`
          : `${at} yayını yapılmadı.`,
      url: "/portal",
      tag: "slot-bos",
    };
  }
  if (input.reason === "blocked") {
    return {
      title: "Yayın yapılamadı: Instagram bağlantısı",
      body: `${at} yayını yapılamadı. Videoların kuyrukta yerinde duruyor.`,
      url: "/portal",
      tag: "slot-bos",
    };
  }
  return {
    title: "Kuyrukta video kalmadı",
    body: `${at} yayını için video yoktu. Yeni video yükleyebilirsin.`,
    url: "/portal",
    tag: "slot-bos",
  };
}

export function digestPush(input: {
  timezone: string;
  pendingCount: number | null;
  upcoming: { slotAt: Date; caption: string }[];
}): PushPayload | null {
  const [first] = input.upcoming;
  if (first) {
    const more = input.upcoming.length - 1;
    return {
      title: `Yarın ${formatTime(first.slotAt, input.timezone)}'da yayınlanacak`,
      body:
        (captionHead(first.caption, 80) || "Sıradaki video") +
        (more > 0 ? ` (+${more} video daha)` : ""),
      url: "/portal",
      tag: "gunluk-ozet",
    };
  }
  if (input.pendingCount && input.pendingCount > 0) {
    return {
      title: `${input.pendingCount} video onayını bekliyor`,
      body: "Onaylı video olmadığı için yarın yayın yapılmayacak.",
      url: "/portal",
      tag: "gunluk-ozet",
    };
  }
  return null;
}
