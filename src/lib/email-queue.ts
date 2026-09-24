import { sendRawEmail, type EmailResult } from "@/lib/email";

/**
 * Video kuyruğu (V4) — müşteriye giden e-postalar (README §6).
 *
 * Hepsi `sendRawEmail` → `gonder()` üzerinden: resend@4 hata hâlinde THROW
 * ETMEZ, `{ data, error }` döner ve dönüşü okumayan çağrı reddedilen gönderimi
 * iz bırakmadan yutar (CLAUDE.md). `email.ts`e değil buraya konuldu: o dosya
 * ajans akışının şablonlarını taşıyor, kuyruk şablonları kendi başına bir aile.
 *
 * Alıcı her zaman `PublishSettings.notifyEmail ?? Client.email` (`queueRecipient`).
 * Hiçbir şablon sır taşımaz: hata nedeni `safeReason`dan geçer.
 */

const ACCENT = "#1e3a34";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Yayın sonucu e-postalarının adresi: ayarda özel adres yoksa müşterinin kendisi. */
export function queueRecipient(
  settings: { notifyEmail: string | null } | null | undefined,
  clientEmail: string
): string {
  const custom = settings?.notifyEmail?.trim();
  return custom ? custom : clientEmail;
}

/** Portal linki; `APP_URL` yoksa link hiç konmaz (yanlış hosta işaret etmesin). */
export function portalUrl(): string | null {
  const base = process.env.APP_URL;
  return base ? `${base.replace(/\/+$/, "")}/portal` : null;
}

/** Caption'ın ilk satırı, kısaltılmış — e-postada videoyu tanıtmak için. */
export function captionHead(caption: string, max = 120): string {
  const first = caption.trim().split("\n")[0]?.trim() ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/**
 * Hata metnini müşteriye gösterilebilir hâle getirir.
 *
 * `publishError` bugün `IGError.report()`tan geliyor ve token taşımıyor; ama
 * bu e-posta şirket DIŞINA gidiyor, o yüzden ikinci bir kat: sorgu dizgili
 * her URL (imzalı R2 linki, `access_token=`li Graph çağrısı) ve `access_token`
 * kalıbı ayıklanır, uzunluk kırpılır. `fbtrace_id` kalır — Meta desteğinde işe yarar.
 */
export function safeReason(detail: string | null | undefined): string {
  if (!detail) return "Bilinmeyen hata";
  return detail
    .replace(/https?:\/\/[^\s?]+\?\S*/gi, "[bağlantı gizlendi]")
    .replace(/(access_token|X-Amz-[A-Za-z]+|signature)=[^\s&]+/gi, "$1=[gizlendi]")
    .slice(0, 300);
}

function formatSlot(at: Date, timeZone: string): string {
  return at.toLocaleString("tr-TR", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(at: Date, timeZone: string): string {
  return at.toLocaleTimeString("tr-TR", { timeZone, hour: "2-digit", minute: "2-digit" });
}

type Link = { label: string; url: string };

/** Ortak çerçeve — text ve HTML aynı satır listesinden. */
function render(lines: string[], link: Link | null, extraHtml = ""): { html: string; text: string } {
  const text = [...lines, ...(link ? [`${link.label}: ${link.url}`] : [])].join("\n\n");
  const body = lines
    .map(
      (line) =>
        `<p style="font-size: 15px; line-height: 1.5; margin: 0 0 12px;">${escapeHtml(line)}</p>`
    )
    .join("\n    ");
  const button = link
    ? `<a href="${escapeHtml(link.url)}" style="display: inline-block; background: ${ACCENT}; color: #ffffff; text-decoration: none; font-size: 15px; padding: 12px 24px; border-radius: 6px; margin-top: 8px;">${escapeHtml(link.label)}</a>`
    : "";
  const html = `<div style="font-family: 'Public Sans', Arial, sans-serif; background: #fafaf8; color: #1a1a1a; padding: 32px 16px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px;">
    ${body}
    ${extraHtml}${button}
  </div>
</div>`;
  return { html, text };
}

// ─── Yayın başarılı ────────────────────────────────────────────────────────

export type QueuePublishedInput = {
  to: string;
  clientName: string;
  caption: string;
  igPermalink: string | null;
};

export function queuePublishedSubject(): string {
  return "Videon Instagram'da yayınlandı";
}

export function renderQueuePublished(input: QueuePublishedInput) {
  const lines = [
    `Merhaba ${input.clientName},`,
    "Kuyruğundaki sıradaki video Instagram'a yayınlandı.",
    `“${captionHead(input.caption)}”`,
  ];
  if (!input.igPermalink) lines.push("Instagram bağlantısı alınamadı; video profilinde görünüyor.");
  return render(lines, input.igPermalink ? { label: "Instagram'da gör", url: input.igPermalink } : null);
}

export function sendQueuePublishedEmail(input: QueuePublishedInput): Promise<EmailResult> {
  return sendRawEmail(
    { to: input.to, subject: queuePublishedSubject(), ...renderQueuePublished(input) },
    "kuyruk yayını başarılı"
  );
}

// ─── Yayın başarısız ───────────────────────────────────────────────────────

export type QueueFailedInput = {
  to: string;
  clientName: string;
  caption: string;
  /** Ham `publishError`; şablon kendisi `safeReason`dan geçirir. */
  reason: string | null;
  portalUrl: string | null;
};

export function queueFailedSubject(): string {
  return "Video yayınlanamadı";
}

export function renderQueueFailed(input: QueueFailedInput) {
  const lines = [
    `Merhaba ${input.clientName},`,
    "Sırası gelen video Instagram'a yayınlanamadı:",
    `“${captionHead(input.caption)}”`,
    `Neden: ${safeReason(input.reason)}`,
    // Kuyruğun durmadığını söylemek önemli: kullanıcı "her şey durdu" sanıp
    // paniğe kapılmasın, ama hatalı videoyla ilgilenmesi gerektiğini de bilsin.
    "Video kuyrukta hata işaretiyle bekliyor; sonraki yayın saatinde sıradaki video yayınlanacak. " +
      "Portaldan tekrar deneyebilir ya da videoyu sona atabilirsin.",
  ];
  return render(lines, input.portalUrl ? { label: "Kuyruğa git", url: input.portalUrl } : null);
}

export function sendQueueFailedEmail(input: QueueFailedInput): Promise<EmailResult> {
  return sendRawEmail(
    { to: input.to, subject: queueFailedSubject(), ...renderQueueFailed(input) },
    "kuyruk yayını başarısız"
  );
}

// ─── Slot boş kaldı ────────────────────────────────────────────────────────

export type SlotEmptyReason =
  /** Onay açık, kuyrukta video var ama hiçbiri onaylı değil. */
  | "no_approved"
  /** Yayınlanabilecek video yok (kuyruk boş ya da caption'lar hazır değil). */
  | "empty"
  /** Instagram tarafı hazır değil — video HARCANMADI, kuyruk yerinde. */
  | "blocked";

export type SlotEmptyInput = {
  to: string;
  clientName: string;
  slotAt: Date;
  timezone: string;
  reason: SlotEmptyReason;
  /** no_approved: onay bekleyen hazır video sayısı. */
  pendingCount?: number;
  /** blocked: ne eksik (sırsız, sabit metin). */
  detail?: string | null;
  portalUrl: string | null;
};

export function slotEmptySubject(input: Pick<SlotEmptyInput, "reason">): string {
  if (input.reason === "no_approved") return "Bu saatte yayınlanacak onaylı video yoktu";
  if (input.reason === "blocked") return "Yayın yapılamadı: Instagram bağlantısı";
  return "Kuyrukta yayınlanacak video kalmadı";
}

export function renderSlotEmpty(input: SlotEmptyInput) {
  const when = formatSlot(input.slotAt, input.timezone);
  const lines = [`Merhaba ${input.clientName},`];
  if (input.reason === "no_approved") {
    lines.push(`${when} yayını için onaylı video yoktu, bu saatte yayın yapılmadı.`);
    if (input.pendingCount && input.pendingCount > 0) {
      lines.push(
        `${input.pendingCount} video onayını bekliyor. Onaylarsan sıradaki yayın saatinde yayınlanır.`
      );
    }
  } else if (input.reason === "blocked") {
    lines.push(`${when} yayını yapılamadı: ${input.detail ?? "Instagram bağlantısı hazır değil"}.`);
    lines.push("Videoların kuyrukta yerinde duruyor; bağlantı düzelince yayınlar kaldığı yerden sürer.");
  } else {
    lines.push(`${when} yayını için kuyrukta yayınlanabilecek video yoktu.`);
    lines.push("Yayınların devam etmesi için yeni video yükleyebilirsin.");
  }
  return render(lines, input.portalUrl ? { label: "Kuyruğa git", url: input.portalUrl } : null);
}

export function sendSlotEmptyEmail(input: SlotEmptyInput): Promise<EmailResult> {
  return sendRawEmail(
    { to: input.to, subject: slotEmptySubject(input), ...renderSlotEmpty(input) },
    "kuyruk slotu boş"
  );
}

// ─── Günlük özet ───────────────────────────────────────────────────────────

export type DigestUpcoming = {
  slotAt: Date;
  caption: string;
  /** Kapak karesinin imzalı URL'i (7 gün); üretilemediyse null. */
  coverUrl: string | null;
};

export type QueueDigestInput = {
  to: string;
  clientName: string;
  timezone: string;
  /** Onay açıksa bekleyen hazır video sayısı; onay kapalıysa null (satır basılmaz). */
  pendingCount: number | null;
  /** Yarın yayınlanacaklar (`projectSchedule`). */
  upcoming: DigestUpcoming[];
  portalUrl: string | null;
};

export function queueDigestSubject(input: Pick<QueueDigestInput, "upcoming" | "pendingCount">): string {
  if (input.upcoming.length > 0) {
    return input.upcoming.length === 1
      ? "Yarın 1 video yayınlanacak"
      : `Yarın ${input.upcoming.length} video yayınlanacak`;
  }
  return `${input.pendingCount ?? 0} video onayını bekliyor`;
}

function digestLines(input: QueueDigestInput): string[] {
  const lines = [`Merhaba ${input.clientName},`];
  for (const item of input.upcoming) {
    lines.push(`Yarın ${formatTime(item.slotAt, input.timezone)}: “${captionHead(item.caption)}”`);
  }
  if (input.upcoming.length > 0) {
    // Onay kapalıyken kullanıcının son görme şansı bu e-posta (K4).
    lines.push("İstemediğin bir video varsa portaldan sırasını değiştirebilirsin.");
  }
  if (input.pendingCount !== null && input.pendingCount > 0) {
    lines.push(`${input.pendingCount} video onayını bekliyor.`);
    if (input.upcoming.length === 0) {
      lines.push("Onaylı video olmadığı için yarın yayın yapılmayacak.");
    }
  }
  return lines;
}

export function renderQueueDigest(input: QueueDigestInput) {
  const covers = input.upcoming
    .filter((item) => item.coverUrl)
    .map(
      (item) =>
        `<img src="${escapeHtml(item.coverUrl!)}" alt="${escapeHtml(
          captionHead(item.caption, 60)
        )}" style="width: 120px; height: 213px; object-fit: cover; border-radius: 6px; margin: 0 8px 12px 0;" />`
    )
    .join("");
  return render(
    digestLines(input),
    input.portalUrl ? { label: "Kuyruğa git", url: input.portalUrl } : null,
    covers ? `<div>${covers}</div>\n    ` : ""
  );
}

export function sendQueueDigestEmail(input: QueueDigestInput): Promise<EmailResult> {
  return sendRawEmail(
    { to: input.to, subject: queueDigestSubject(input), ...renderQueueDigest(input) },
    "kuyruk günlük özeti"
  );
}
