import { gonder, type EmailResult } from "@/lib/email";

/**
 * Video kuyruğu (V3) — müşteri portalının giriş e-postası.
 *
 * Şablon ayrı dosyada çünkü portal müşterinin KENDİ ekranı: ajans markası
 * yerine müşterinin adı öne çıkıyor. Gönderim yine `gonder()` üzerinden —
 * Resend dönüşünü okumayan bir çağrı reddedilen maili iz bırakmadan yutar
 * (CLAUDE.md).
 */

export type PortalLoginEmailInput = {
  to: string;
  clientName: string;
  loginUrl: string;
  /** Link geçerlilik süresi (dakika) — metinde söyleniyor ki "link çalışmadı" sorusu azalsın. */
  ttlMinutes: number;
  /**
   * Ajans müşteriye portal erişimi AÇTIĞINDA ilk mail bir davettir; kullanıcı
   * "bu da nereden çıktı" demesin diye konu ve giriş cümlesi farklı.
   */
  invited?: boolean;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function portalLoginSubject(input: Pick<PortalLoginEmailInput, "invited">): string {
  return input.invited ? "Video portalına erişimin açıldı" : "Video portalı giriş linkin";
}

export function renderPortalLoginText({
  clientName,
  loginUrl,
  ttlMinutes,
  invited,
}: Omit<PortalLoginEmailInput, "to">): string {
  const giris = invited
    ? "Video portalına erişimin açıldı. Buradan videolarını yükleyip yayın sırasını yönetebilirsin."
    : "Video portalına giriş yapmak için bir link istedin.";
  return `Merhaba ${clientName},

${giris}

Giriş linki:
${loginUrl}

Link ${ttlMinutes} dakika geçerli ve yalnızca bir kez kullanılabilir.
Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.`;
}

export function renderPortalLoginHtml({
  clientName,
  loginUrl,
  ttlMinutes,
  invited,
}: Omit<PortalLoginEmailInput, "to">): string {
  const client = escapeHtml(clientName);
  const url = escapeHtml(loginUrl);
  const giris = invited
    ? "Video portalına erişimin açıldı. Buradan videolarını yükleyip yayın sırasını yönetebilirsin."
    : "Video portalına giriş yapmak için bir link istedin.";
  return `<div style="font-family: 'Public Sans', Arial, sans-serif; background: #fafaf8; color: #1a1a1a; padding: 32px 16px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px;">
    <p style="font-size: 16px; margin: 0 0 8px;">Merhaba ${client},</p>
    <p style="font-size: 16px; line-height: 1.5; margin: 0 0 24px;">${escapeHtml(giris)}</p>
    <a href="${url}" style="display: inline-block; background: #1e3a34; color: #ffffff; text-decoration: none; font-size: 16px; padding: 14px 28px; border-radius: 6px;">Portala giriş yap</a>
    <p style="font-size: 13px; color: #6b6b6b; margin: 24px 0 0;">Link ${ttlMinutes} dakika geçerli ve yalnızca bir kez kullanılabilir. Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.</p>
  </div>
</div>`;
}

export async function sendPortalLoginEmail(input: PortalLoginEmailInput): Promise<EmailResult> {
  return gonder(
    {
      to: input.to,
      subject: portalLoginSubject(input),
      html: renderPortalLoginHtml(input),
      text: renderPortalLoginText(input),
    },
    "portal giriş e-postası"
  );
}
