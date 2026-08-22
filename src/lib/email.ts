import { Resend } from "resend";
import { INVITE_TTL_DAYS } from "@/lib/tokens";

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

// ------------------------------------------------- revize post bildirimi (F10)

/**
 * Müşteriye "istediğin düzeltme yapıldı, tekrar bakar mısın" e-postası.
 *
 * İlk onay e-postasının kopyası DEĞİL, çünkü müşterinin bu kez sorduğu soru
 * farklı: "yeni bir post mu geldi" değil, "benim dediğim yapılmış mı". Bu yüzden
 * gövde müşterinin KENDİ isteğini geri okur — hatırlaması için başka yere
 * bakmak zorunda kalmasın — ve ajansın notu varsa onu ekler.
 *
 * Link BİLEREK aynı token: revizyon aynı işin devamı, müşteri elindeki eski
 * maildeki linke dönse de doğru yere düşer (bkz. `resubmitForApproval`).
 */
export type RevisedPostEmailInput = ApprovalEmailInput & {
  /** Müşterinin bu tur ne istediği — kendi cümlesi. */
  revisionRequest?: string | null;
  /** Ajansın "şunu değiştirdim" notu. */
  agencyNote?: string | null;
  /** Kaçıncı tur — ikinci turdan sonrası için konu satırında anlamlı. */
  round: number;
};

export function revisedPostEmailSubject(agencyName: string): string {
  return `${agencyName} istediğin düzeltmeyi yaptı`;
}

function revisedPostLines({
  agencyName,
  revisionRequest,
  agencyNote,
  round,
}: Omit<RevisedPostEmailInput, "to">): string[] {
  const lines = [
    `${agencyName} istediğin düzeltmeleri yaptı ve postu tekrar onayına gönderdi` +
      (round > 1 ? ` (${round}. tur).` : "."),
  ];
  if (revisionRequest) lines.push(`Senin isteğin: ${revisionRequest}`);
  if (agencyNote) lines.push(`Ajansın notu: ${agencyNote}`);
  lines.push("Aşağıdaki bağlantıdan güncel hâlini görebilirsin.");
  return lines;
}

export function renderRevisedPostEmailText(
  input: Omit<RevisedPostEmailInput, "to">
): string {
  return `Merhaba ${input.clientName},

${revisedPostLines(input).join("\n\n")}

${input.approvalUrl}

Giriş yapmanız gerekmez.`;
}

export function renderRevisedPostEmailHtml(
  input: Omit<RevisedPostEmailInput, "to">
): string {
  const client = escapeHtml(input.clientName);
  const url = escapeHtml(input.approvalUrl);
  const accent =
    input.brandColor && HEX_COLOR_RE.test(input.brandColor)
      ? input.brandColor
      : DEFAULT_ACCENT;
  const logoHtml = input.logoUrl
    ? `<img src="${escapeHtml(input.logoUrl)}" alt="${escapeHtml(input.agencyName)}" style="height: 40px; max-width: 160px; object-fit: contain; margin-bottom: 16px;" />\n    `
    : "";
  const body = revisedPostLines(input)
    .map(
      (line) =>
        `<p style="font-size: 16px; line-height: 1.5; margin: 0 0 12px;">${escapeHtml(line)}</p>`
    )
    .join("\n    ");
  return `<div style="font-family: 'Public Sans', Arial, sans-serif; background: #fafaf8; color: #1a1a1a; padding: 32px 16px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px;">
    ${logoHtml}<p style="font-size: 16px; margin: 0 0 8px;">Merhaba ${client},</p>
    ${body}
    <a href="${url}" style="display: inline-block; background: ${accent}; color: #ffffff; text-decoration: none; font-size: 16px; padding: 14px 28px; border-radius: 6px; margin-top: 12px;">G&uuml;ncel h&acirc;lini g&ouml;r</a>
    <p style="font-size: 13px; color: #6b6b6b; margin: 24px 0 0;">Giriş yapmanız gerekmez.</p>
  </div>
</div>`;
}

export async function sendRevisedPostEmail(
  input: RevisedPostEmailInput
): Promise<EmailResult> {
  return gonder(
    {
      to: input.to,
      subject: revisedPostEmailSubject(input.agencyName),
      html: renderRevisedPostEmailHtml(input),
      text: renderRevisedPostEmailText(input),
    },
    "revize post bildirimi"
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
  | "link_expired"
  /**
   * Müşteri düzeltme istedi (F10). `rejected`'dan ayrı bir olay: reddedilmiş
   * postta yapılacak bir şey yok, burada TOP AJANSTA — mailin de bunu söylemesi
   * gerekiyor, yoksa ajans "reddedildi" sanıp işi kapatır.
   */
  | "revision_requested";

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
  /** F8: publishStatus "scheduled" ise yayının planlandığı an — TR saatiyle gösterilir. */
  publishAt?: Date | null;
  /** revision_requested: müşterinin kendi cümlesiyle ne istediği (F10). */
  revisionRequest?: string | null;
  /** revision_requested: kaçıncı tur. */
  revisionRound?: number;
};

const YAYIN_METNI: Record<string, string> = {
  published: "Instagram'a yayınlandı",
  failed: "Instagram'a YAYINLANAMADI — onay sayfasından tekrar denenebilir",
  skipped: "Yayınlanmadı: müşteride Instagram bağlı değil",
  duplicate: "Yayınlanmadı: aynı post zaten Instagram'da",
  idle: "Yayın henüz denenmedi",
  // F8: "yayınlandı" değil — yanıltıcı olurdu, aşağıda gerçek zaman eklenir.
  scheduled: "Onaylandı, planlanan saatte yayınlanacak",
};

export function agencyNoticeSubject(input: AgencyNoticeInput): string {
  const etiket = {
    request_sent: "Onay bekliyor",
    approved: "Onaylandı",
    rejected: "Reddedildi",
    link_expired: "Link süresi doldu",
    revision_requested: "Revizyon istendi",
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
    // F8: "onaylandı ama şu saatte yayınlanacak" — hangi saat sorusunun
    // cevabı burada, aksi halde "planlanan saatte" belirsiz kalırdı.
    if (input.publishStatus === "scheduled" && input.publishAt) {
      lines.push(
        `Planlanan zaman: ${input.publishAt.toLocaleString("tr-TR", {
          timeZone: "Europe/Istanbul",
          dateStyle: "medium",
          timeStyle: "short",
        })} (TR saati)`
      );
    }
    if (input.igPermalink) lines.push(`Post: ${input.igPermalink}`);
  } else if (input.event === "revision_requested") {
    // "Reddetti" demiyoruz bilerek: post ölmedi, sırada ajans var. Cümlenin
    // eylem çağrısıyla bitmesi bu yüzden önemli.
    lines.push(
      `${input.clientName} postta DÜZELTME istedi` +
        (input.revisionRound && input.revisionRound > 1
          ? ` (${input.revisionRound}. tur).`
          : ".")
    );
    lines.push(
      input.revisionRequest
        ? `İsteği: ${input.revisionRequest}`
        : "Ne istediğini yazmadı — müşteriyle konuşman gerekebilir."
    );
    lines.push(
      "Panelden postu düzeltip \"Düzeltip tekrar gönder\" ile onaya geri yolla; " +
        "müşteriye aynı linkten haber gider."
    );
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

// ------------------------------------------------------------- ekip daveti (F6)

/**
 * Ekip daveti maili. Müşteriye giden onay maillerinden AYRI bir metin: burada
 * karşı taraf bir müşteri değil, ajansın kendi çalışanı — istenen eylem de
 * onay değil, hesap açmak.
 *
 * Mail, hangi ADRESE gönderildiğini gövdede açıkça yazıyor. Sebebi kozmetik
 * değil: katılım o adresle giriş yapmayı gerektiriyor (bkz. membership.ts),
 * yani "başka Google hesabımla girdim, çalışmadı" en olası destek sorusu.
 * Cevabı mailin içine koymak, o soruyu hiç sordurmamak demek.
 */
export type TeamInviteInput = {
  to: string;
  agencyName: string;
  inviteUrl: string;
  /** Daveti kimin gönderdiği — alıcı "bu mail gerçek mi" sorusunu yanıtlayabilsin. */
  invitedByEmail?: string | null;
  logoUrl?: string | null;
  brandColor?: string | null;
};

export function teamInviteSubject(agencyName: string): string {
  return `${agencyName} seni ekibine davet etti`;
}

function teamInviteLines(input: Omit<TeamInviteInput, "to">, to: string): string[] {
  const lines = [
    `${input.agencyName} seni Content Approval panelindeki ekibine davet etti.`,
  ];
  if (input.invitedByEmail) lines.push(`Daveti gönderen: ${input.invitedByEmail}`);
  lines.push(
    `Katılmak için aşağıdaki bağlantıyı aç ve Google ile giriş yap. ` +
      `Giriş yaparken MUTLAKA ${to} adresine bağlı Google hesabını kullan — ` +
      `davet yalnızca bu adresle kabul edilir.`
  );
  lines.push(`Bu davet ${INVITE_TTL_DAYS} gün boyunca geçerlidir.`);
  return lines;
}

export function renderTeamInviteText(input: TeamInviteInput): string {
  return `${teamInviteLines(input, input.to).join("\n\n")}\n\n${input.inviteUrl}`;
}

export function renderTeamInviteHtml(input: TeamInviteInput): string {
  const accent =
    input.brandColor && HEX_COLOR_RE.test(input.brandColor)
      ? input.brandColor
      : DEFAULT_ACCENT;
  const logoHtml = input.logoUrl
    ? `<img src="${escapeHtml(input.logoUrl)}" alt="${escapeHtml(input.agencyName)}" style="height: 40px; max-width: 160px; object-fit: contain; margin-bottom: 16px;" />\n    `
    : "";
  const body = teamInviteLines(input, input.to)
    .map(
      (line) =>
        `<p style="font-size: 15px; line-height: 1.5; margin: 0 0 12px;">${escapeHtml(line)}</p>`
    )
    .join("\n    ");
  return `<div style="font-family: 'Public Sans', Arial, sans-serif; background: #fafaf8; color: #1a1a1a; padding: 32px 16px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px;">
    ${logoHtml}${body}
    <a href="${escapeHtml(input.inviteUrl)}" style="display: inline-block; background: ${accent}; color: #ffffff; text-decoration: none; font-size: 16px; padding: 14px 28px; border-radius: 6px;">Daveti kabul et</a>
  </div>
</div>`;
}

export async function sendTeamInviteEmail(input: TeamInviteInput): Promise<EmailResult> {
  // `gonder()` üzerinden — `resend.emails.send` DOĞRUDAN çağrılmaz; gerekçe
  // için bkz. `gonder` ve `sendRawEmail` yorumları (resend@4 throw etmez).
  return gonder(
    {
      to: input.to,
      subject: teamInviteSubject(input.agencyName),
      html: renderTeamInviteHtml(input),
      text: renderTeamInviteText(input),
    },
    "ekip daveti"
  );
}

// ------------------------------------------------------------- sistem uyarısı (F11)

/**
 * `alerts.ts`in DIŞARIDAN erişebildiği tek kapı. `gonder()` bilerek dışa
 * açılmıyor gibi görünse de burada ince bir sarmalayıcıyla dışa veriliyor:
 * amaç `alerts.ts`nin `resend.emails.send`'i DOĞRUDAN çağırmasını engellemek.
 * Sebep yukarıdaki `gonder` yorumundaki ile birebir aynı — resend@4 API
 * hatalarında THROW ETMEZ, `{ data, error }` döner; bu dönüş okunmazsa
 * reddedilen uyarı maili de iz bırakmadan kaybolur. Tek doğru yol `gonder()`.
 */
export async function sendRawEmail(
  payload: { to: string; subject: string; html: string; text: string },
  etiket: string
): Promise<EmailResult> {
  return gonder(payload, etiket);
}
