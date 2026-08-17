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

// Fire-and-forget: gönderim başarısız olsa bile ASLA throw etmez — post oluşturma
// akışı e-postaya bağımlı değildir. Ama SESSİZ de kalmaz: sonucu döndürür ki
// çağıran taraf "post oluştu ama müşteriye haber gitmedi" durumunu görebilsin.
export async function sendApprovalRequestEmail(
  input: ApprovalEmailInput
): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const reason = "RESEND_API_KEY tanımlı değil";
    console.warn(`[email] ${reason}, onay e-postası gönderimi atlandı`);
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
      to: input.to,
      subject: approvalEmailSubject(input.agencyName),
      html: renderApprovalEmailHtml(input),
      text: renderApprovalEmailText(input),
    });
    if (error) {
      const reason = `${error.name ?? "resend_error"}: ${error.message ?? "bilinmeyen"}`;
      console.error("[email] Resend gönderimi reddetti:", error);
      return { sent: false, reason };
    }
    return { sent: true };
  } catch (error) {
    console.error("[email] Onay e-postası gönderilemedi:", error);
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
