import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getScopedDb } from "@/lib/scoped-db";
import { checkOrigin } from "@/lib/origin";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { maxPendingInvitesPerAgency } from "@/lib/quota";
import { sendTeamInviteEmail } from "@/lib/email";
import { validateClientEmail } from "@/lib/validation";

/**
 * F6 — ekip yönetimi.
 *
 * Bütün okuma/yazma `getScopedDb(session)` üzerinden gidiyor: bir ajansın
 * üyesi başka ajansın ekibini ne görebilir ne değiştirebilir. `agencyId`
 * İSTEKTEN ALINMAZ, oturumdan gelir — IDOR için gövdede taşınacak bir
 * tanımlayıcı yok.
 */

function appBaseUrl(request: Request): string {
  return process.env.APP_URL ?? new URL(request.url).origin;
}

export async function GET() {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }
  const scoped = getScopedDb(session);
  // Üyeler ve bekleyen davetler birlikte: panel tek istekte tam tabloyu
  // çizebilsin. Liste HER ÜYEYE açık (yalnızca owner'a değil) — kiminle
  // çalıştığını bilmek yetki değil, şeffaflık.
  const [members, invites] = await Promise.all([
    scoped.members.findMany(),
    scoped.invites.findPending(),
  ]);
  return NextResponse.json({ members, invites, role: session.agencyRole ?? null });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  // Origin kontrolü (S8, CSRF ikinci katman) — bkz. /api/agency. Bu route
  // mail gönderiyor, yani CSRF'in bedeli yalnızca veri değişikliği değil,
  // ajansın adına giden mail.
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  // Yetki: davet etmek owner işi. `member`'ın ekibi büyütmesi, ajans
  // sahibinin kontrolü dışında yeni erişim yaratması demek olurdu.
  if (session.agencyRole !== "owner") {
    return NextResponse.json(
      { error: "Yalnızca ajans sahibi ekip üyesi davet edebilir" },
      { status: 403 }
    );
  }

  // Davet spam'i: mail gönderen bir yüzey olduğu için HIZ da sınırlanıyor.
  // Anahtar IP değil AJANS — aynı ajans farklı IP'lerden (mobil/ofis) aynı
  // tavana çarpsın, farklı ajanslar birbirini kilitlemesin.
  if (await checkRateLimit(`invite:${session.agencyId}`)) {
    return NextResponse.json(
      { error: "Çok fazla davet gönderildi, biraz sonra tekrar deneyin" },
      { status: 429 }
    );
  }
  // IP okunuyor ama şu an yalnızca log için — kötüye kullanım araştırılırsa
  // "hangi ajans, nereden" sorusunun cevabı gerekir.
  const ip = getClientIp(request.headers);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
  }
  const { email, role } = (body ?? {}) as { email?: unknown; role?: unknown };

  const emailError = validateClientEmail(email);
  if (emailError) {
    return NextResponse.json({ error: emailError, field: "email" }, { status: 400 });
  }
  // Rol allowlist: gövdeden gelen serbest metin doğrudan enum'a yazılmaz.
  // Varsayılan `member` — yetkiyi yanlışlıkla yükseltmek, yanlışlıkla
  // düşürmekten çok daha pahalı.
  if (role !== undefined && role !== "owner" && role !== "member") {
    return NextResponse.json({ error: "Geçersiz rol", field: "role" }, { status: 400 });
  }
  const inviteRole = role === "owner" ? "owner" : "member";

  // Daveti kimin gönderdiği mailde de, panelde de görünüyor: alıcı "bu mail
  // gerçek mi" diye sorduğunda cevabı gövdede bulsun.
  const invitedByEmail = session.user?.email ?? null;

  const scoped = getScopedDb(session);
  const result = await scoped.invites.create({
    email: email as string,
    role: inviteRole,
    invitedByEmail,
    maxPending: maxPendingInvitesPerAgency(),
  });

  if (!result.ok) {
    const message = {
      already_member: "Bu e-posta zaten ekibinde",
      already_invited: "Bu e-postaya zaten bekleyen bir davet var",
      invite_quota: `Bekleyen davet tavanına ulaşıldı (${maxPendingInvitesPerAgency()}). Kullanılmayan davetleri iptal et.`,
    }[result.reason];
    // Kota 403, diğerleri 409: biri "izin yok", diğerleri "durum zaten böyle".
    const status = result.reason === "invite_quota" ? 403 : 409;
    return NextResponse.json({ error: message, field: "email" }, { status });
  }

  const agency = await db.agency.findUnique({
    where: { id: session.agencyId },
    select: { name: true, logoUrl: true, brandColor: true },
  });

  const inviteUrl = `${appBaseUrl(request)}/invite/${result.token}`;
  // `gonder()` üzerinden (sendTeamInviteEmail) — resend@4 throw etmiyor,
  // dönüşü OKUMAK zorundayız; okunmazsa reddedilen davet iz bırakmadan yutulur
  // ve owner "davet gitti" sanır. Mail başarısız olsa da davet KAYDI duruyor:
  // link panelde gösterilebilir, elden iletilebilir.
  const mail = await sendTeamInviteEmail({
    to: result.invite.email,
    agencyName: agency?.name ?? "Ajansın",
    inviteUrl,
    invitedByEmail,
    logoUrl: agency?.logoUrl ?? null,
    brandColor: agency?.brandColor ?? null,
  });
  if (!mail.sent) {
    console.error(
      `[members] davet maili gönderilemedi (ajans=${session.agencyId}, ip=${ip}): ${mail.reason}`
    );
  }

  return NextResponse.json(
    { invite: result.invite, emailSent: mail.sent, inviteUrl },
    { status: 201 }
  );
}
