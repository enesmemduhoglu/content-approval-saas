import { Resend } from "resend";

export type ApprovalEmailInput = {
  to: string;
  agencyName: string;
  clientName: string;
  approvalUrl: string;
  // Ajans markalama (D3.4) — opsiyonel; yoksa varsayılan görünüm kullanılır
  logoUrl?: string | null;
  brandColor?: string | null;
};

const DEFAULT_ACCENT = "#1e3a34";
// E-postaya yalnızca doğrulanmış hex renk gömülür — CSS injection engeli
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function approvalEmailSubject(agencyName: string): string {
  return `${agencyName} sizin için bir post hazırladı`;
}

// Düz metin alternatifi: salt-HTML mailler spam filtrelerinde puan kaybeder;
// multipart (text+html) gönderim teslim edilebilirliği artırır.
export function renderApprovalEmailText({
  agencyName,
  clientName,
  approvalUrl,
}: Omit<ApprovalEmailInput, "to">): string {
  return `Merhaba ${clientName},

${agencyName} sizin için yeni bir sosyal medya postu hazırladı.
Aşağıdaki bağlantıdan inceleyip tek tıkla onaylayabilir veya reddedebilirsiniz:

${approvalUrl}

Bu bağlantı 7 gün boyunca geçerlidir. Giriş yapmanız gerekmez.`;
}

export function renderApprovalEmailHtml({
  agencyName,
  clientName,
  approvalUrl,
  logoUrl,
  brandColor,
}: Omit<ApprovalEmailInput, "to">): string {
  const agency = escapeHtml(agencyName);
  const client = escapeHtml(clientName);
  const url = escapeHtml(approvalUrl);
  const accent =
    brandColor && HEX_COLOR_RE.test(brandColor) ? brandColor : DEFAULT_ACCENT;
  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${agency}" style="height: 40px; max-width: 160px; object-fit: contain; margin-bottom: 16px;" />\n    `
    : "";
  return `<div style="font-family: 'Public Sans', Arial, sans-serif; background: #fafaf8; color: #1a1a1a; padding: 32px 16px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px;">
    ${logoHtml}<p style="font-size: 16px; margin: 0 0 8px;">Merhaba ${client},</p>
    <p style="font-size: 16px; line-height: 1.5; margin: 0 0 24px;">
      <strong>${agency}</strong> sizin i&ccedil;in yeni bir sosyal medya postu hazırladı.
      Aşağıdaki bağlantıdan inceleyip tek tıkla onaylayabilir veya reddedebilirsiniz.
    </p>
    <a href="${url}" style="display: inline-block; background: ${accent}; color: #ffffff; text-decoration: none; font-size: 16px; padding: 14px 28px; border-radius: 6px;">İncele ve Onayla</a>
    <p style="font-size: 13px; color: #6b6b6b; margin: 24px 0 0;">Bu bağlantı 7 g&uuml;n boyunca ge&ccedil;erlidir. Giriş yapmanız gerekmez.</p>
  </div>
</div>`;
}

export type EmailResult =
  | { sent: true }
  | { sent: false; reason: string };

// Fire-and-forget: gönderim başarısız olsa bile ASLA throw etmez — çağıran akış
// e-postaya bağımlı değildir. Ama SESSİZ de kalmaz: sonucu döndürür ki çağıran
// taraf "iş yapıldı ama haber gitmedi" durumunu görebilsin.
async function gonder(
  payload: { to: string; subject: string; html: string; text: string },
  etiket: string
): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const reason = "RESEND_API_KEY tanımlı değil";
    console.warn(`[email] ${reason}, ${etiket} gönderimi atlandı`);
    return { sent: false, reason };
  }
  try {
    const resend = new Resend(apiKey);
    // resend@4 API hatalarında THROW ETMEZ, { data, error } döndürür. Bu dönüş
    // kontrol edilmediği surece reddedilen her gonderim iz birakmadan kaybolur:
    // post 201 doner, durum "pending" kalir, kimse mailin gitmedigini bilmez.
    // 17.08'de tam olarak bu yasandi — iki gun onay maili gitmedi, ne log ne
    // hata vardi. Dönüşü okumak bu sinifin tek teshis yolu.
    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "Content Approval <onboarding@resend.dev>",
      ...payload,
    });
    if (error) {
      const reason = `${error.name ?? "resend_error"}: ${error.message ?? "bilinmeyen"}`;
      console.error(`[email] Resend ${etiket} gönderimini reddetti:`, error);
      return { sent: false, reason };
    }
    return { sent: true };
  } catch (error) {
    console.error(`[email] ${etiket} gönderilemedi:`, error);
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendApprovalRequestEmail(
  input: ApprovalEmailInput
): Promise<EmailResult> {
  return gonder(
    {
      to: input.to,
      subject: approvalEmailSubject(input.agencyName),
      html: renderApprovalEmailHtml(input),
      text: renderApprovalEmailText(input),
    },
    "onay e-postası"
  );
}

// -------------------------------------------------------- hatırlatma (F3)

/**
 * Müşteriye "bu hâlâ onayını bekliyor" hatırlatması.
 *
 * İlk onay e-postasının kopyası DEĞİL: konu satırı hatırlatma olduğunu söylüyor
 * ve gövde kaç gündür beklediğini yazıyor. Aynı maili tekrar göndermek, müşteride
 * "bunu zaten görmüştüm" refleksiyle okunmadan silinmeye yol açardı.
 *
 * Post başına yalnızca BİR KEZ gider (bkz. `reminders.ts` — `reminderSentAt`).
 */
export type ApprovalReminderInput = ApprovalEmailInput & { daysPending: number };

export function approvalReminderSubject(agencyName: string): string {
  return `Hatırlatma: ${agencyName} onayınızı bekliyor`;
}

export function renderApprovalReminderText({
  agencyName,
  clientName,
  approvalUrl,
  daysPending,
}: Omit<ApprovalReminderInput, "to">): string {
  return `Merhaba ${clientName},

${agencyName} tarafından hazırlanan post ${daysPending} gündür onayınızı bekliyor.
Aşağıdaki bağlantıdan inceleyip tek tıkla onaylayabilir veya reddedebilirsiniz:

${approvalUrl}

Bu bağlantının süresi dolduğunda çalışmayacaktır. Giriş yapmanız gerekmez.`;
}

export function renderApprovalReminderHtml({
  agencyName,
  clientName,
  approvalUrl,
  logoUrl,
  brandColor,
  daysPending,
}: Omit<ApprovalReminderInput, "to">): string {
  const agency = escapeHtml(agencyName);
  const client = escapeHtml(clientName);
  const url = escapeHtml(approvalUrl);
  const accent =
    brandColor && HEX_COLOR_RE.test(brandColor) ? brandColor : DEFAULT_ACCENT;
  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${agency}" style="height: 40px; max-width: 160px; object-fit: contain; margin-bottom: 16px;" />\n    `
    : "";
  return `<div style="font-family: 'Public Sans', Arial, sans-serif; background: #fafaf8; color: #1a1a1a; padding: 32px 16px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px;">
    ${logoHtml}<p style="font-size: 16px; margin: 0 0 8px;">Merhaba ${client},</p>
    <p style="font-size: 16px; line-height: 1.5; margin: 0 0 24px;">
      <strong>${agency}</strong> tarafından hazırlanan post
      <strong>${daysPending} g&uuml;nd&uuml;r</strong> onayınızı bekliyor.
      Aşağıdaki bağlantıdan inceleyip tek tıkla onaylayabilir veya reddedebilirsiniz.
    </p>
    <a href="${url}" style="display: inline-block; background: ${accent}; color: #ffffff; text-decoration: none; font-size: 16px; padding: 14px 28px; border-radius: 6px;">İncele ve Onayla</a>
    <p style="font-size: 13px; color: #6b6b6b; margin: 24px 0 0;">Bu bağlantının s&uuml;resi dolduğunda &ccedil;alışmayacaktır. Giriş yapmanız gerekmez.</p>
  </div>
</div>`;
}

export async function sendApprovalReminderEmail(
  input: ApprovalReminderInput
): Promise<EmailResult> {
  return gonder(
    {
      to: input.to,
      subject: approvalReminderSubject(input.agencyName),
      html: renderApprovalReminderHtml(input),
      text: renderApprovalReminderText(input),
    },
    "onay hatırlatması"
  );
}

// ----------------------------------------------------------- ajans bildirimi

/**
 * İş sahibine (ajans) giden bildirim. Müşteri onay e-postasını alıyordu ama
 * ajansın akıştan hiç haberi olmuyordu: onay isteği gitti mi, müşteri ne dedi,
 * post yayınlandı mı — hepsini ancak panele bakarak öğrenebiliyordu.
 */
export type AgencyNoticeEvent =
  | "request_sent"
  | "approved"
  | "rejected"
  /** Onay linki öldü ama post hâlâ bekliyor — yalnızca ajans çözebilir (F3). */
  | "link_expired";

export type AgencyNoticeInput = {
  to: string;
  event: AgencyNoticeEvent;
  clientName: string;
  /** Postu tanıyacak kısa etiket: externalRef ya da caption'ın ilk satırı. */
  postRef: string;
  approvalUrl?: string;
  /** request_sent: müşteriye onay maili gerçekten gitti mi. */
  clientEmailSent?: boolean;
  rejectionReason?: string | null;
  publishStatus?: string | null;
  igPermalink?: string | null;
  /** link_expired: post kaç gündür bekliyor. */
  daysPending?: number;
};

const YAYIN_METNI: Record<string, string> = {
  published: "Instagram'a yayınlandı",
  failed: "Instagram'a YAYINLANAMADI — onay sayfasından tekrar denenebilir",
  skipped: "Yayınlanmadı: müşteride Instagram bağlı değil",
  duplicate: "Yayınlanmadı: aynı post zaten Instagram'da",
  idle: "Yayın henüz denenmedi",
};

export function agencyNoticeSubject(input: AgencyNoticeInput): string {
  const etiket = {
    request_sent: "Onay bekliyor",
    approved: "Onaylandı",
    rejected: "Reddedildi",
    link_expired: "Link süresi doldu",
  }[input.event];
  return `[${etiket}] ${input.clientName} — ${input.postRef}`;
}

/** Bildirimin gövdesi — satır listesi olarak; text ve HTML aynı kaynaktan. */
function agencyNoticeLines(input: AgencyNoticeInput): string[] {
  const lines: string[] = [];
  if (input.event === "request_sent") {
    lines.push(`${input.clientName} için yeni bir post onaya gönderildi.`);
    // Asıl mesele bu satır: 16-17.08'de onay maili gitmedi ve kimse fark
    // etmedi. Ajans artık müşteriye ulaşılıp ulaşılmadığını burada görüyor.
    lines.push(
      input.clientEmailSent === false
        ? "DİKKAT: Müşteriye onay e-postası GİTMEDİ. Aşağıdaki linki elle iletmen gerekiyor."
        : "Müşteriye onay e-postası gönderildi."
    );
  } else if (input.event === "approved") {
    lines.push(`${input.clientName} postu ONAYLADI.`);
    lines.push(YAYIN_METNI[input.publishStatus ?? "idle"] ?? `Yayın durumu: ${input.publishStatus}`);
    if (input.igPermalink) lines.push(`Post: ${input.igPermalink}`);
  } else if (input.event === "link_expired") {
    // Müşteriye hatırlatma göndermenin anlamı yok: elindeki link çalışmıyor.
    // Yapabilecek tek kişi ajans, o yüzden ne yapması gerektiği açıkça yazıyor.
    lines.push(
      `${input.clientName} için gönderilen post hâlâ onay bekliyor` +
        (input.daysPending !== undefined ? ` (${input.daysPending} gündür)` : "") +
        ", ama onay linkinin SÜRESİ DOLDU."
    );
    lines.push(
      "Müşteri artık linke tıklasa da açamaz. Panelden \"Yeni link gönder\" ile " +
        "linki yenile — müşteriye yeni bir onay e-postası gider."
    );
  } else {
    lines.push(`${input.clientName} postu REDDETTİ.`);
    lines.push(
      input.rejectionReason
        ? `Gerekçe: ${input.rejectionReason}`
        : "Gerekçe belirtilmedi."
    );
  }
  if (input.approvalUrl) lines.push(`Onay sayfası: ${input.approvalUrl}`);
  return lines;
}

export function renderAgencyNoticeText(input: AgencyNoticeInput): string {
  return agencyNoticeLines(input).join("\n\n");
}

export function renderAgencyNoticeHtml(input: AgencyNoticeInput): string {
  const body = agencyNoticeLines(input)
    .map(
      (line) =>
        `<p style="font-size: 15px; line-height: 1.5; margin: 0 0 12px;">${escapeHtml(line)}</p>`
    )
    .join("\n    ");
  return `<div style="font-family: 'Public Sans', Arial, sans-serif; background: #fafaf8; color: #1a1a1a; padding: 32px 16px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px;">
    ${body}
  </div>
</div>`;
}

export async function sendAgencyNoticeEmail(input: AgencyNoticeInput): Promise<EmailResult> {
  return gonder(
    {
      to: input.to,
      subject: agencyNoticeSubject(input),
      html: renderAgencyNoticeHtml(input),
      text: renderAgencyNoticeText(input),
    },
    "ajans bildirimi"
  );
}
