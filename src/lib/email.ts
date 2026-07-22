import { Resend } from "resend";

export type ApprovalEmailInput = {
  to: string;
  agencyName: string;
  clientName: string;
  approvalUrl: string;
};

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

export function renderApprovalEmailHtml({
  agencyName,
  clientName,
  approvalUrl,
}: Omit<ApprovalEmailInput, "to">): string {
  const agency = escapeHtml(agencyName);
  const client = escapeHtml(clientName);
  const url = escapeHtml(approvalUrl);
  return `<div style="font-family: 'Public Sans', Arial, sans-serif; background: #fafaf8; color: #1a1a1a; padding: 32px 16px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px;">
    <p style="font-size: 16px; margin: 0 0 8px;">Merhaba ${client},</p>
    <p style="font-size: 16px; line-height: 1.5; margin: 0 0 24px;">
      <strong>${agency}</strong> sizin i&ccedil;in yeni bir sosyal medya postu hazırladı.
      Aşağıdaki bağlantıdan inceleyip tek tıkla onaylayabilir veya reddedebilirsiniz.
    </p>
    <a href="${url}" style="display: inline-block; background: #1e3a34; color: #ffffff; text-decoration: none; font-size: 16px; padding: 14px 28px; border-radius: 6px;">İncele ve Onayla</a>
    <p style="font-size: 13px; color: #6b6b6b; margin: 24px 0 0;">Bu bağlantı 7 g&uuml;n boyunca ge&ccedil;erlidir. Giriş yapmanız gerekmez.</p>
  </div>
</div>`;
}

// Fire-and-forget: gönderim başarısız olsa bile ASLA throw etmez — post oluşturma
// akışı e-postaya bağımlı değildir, hata yalnızca loglanır.
export async function sendApprovalRequestEmail(input: ApprovalEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY tanımlı değil, onay e-postası gönderimi atlandı");
    return;
  }
  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "Content Approval <onboarding@resend.dev>",
      to: input.to,
      subject: approvalEmailSubject(input.agencyName),
      html: renderApprovalEmailHtml(input),
    });
  } catch (error) {
    console.error("[email] Onay e-postası gönderilemedi:", error);
  }
}
