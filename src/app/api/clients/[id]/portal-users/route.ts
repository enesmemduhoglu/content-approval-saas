import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { getAgencyPortalUsers } from "@/lib/portal-users";
import { issueLoginLink } from "@/lib/client-auth";
import { checkOrigin } from "@/lib/origin";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateClientEmail } from "@/lib/validation";

/**
 * Video kuyruğu (V3) — ajansın müşteriye portal erişimi açması.
 *
 * Müşteri `getScopedDb(session).clients.findById` ile doğrulanıyor: başka
 * ajansın müşteri id'si 404. `owner` ve `member` ikisi de yapabilir — müşteri
 * işlerinin tamamı member'a açık (F6), portal erişimi de bir müşteri işi.
 */

type RouteParams = { params: Promise<{ id: string }> };

function appBaseUrl(request: Request): string {
  return process.env.APP_URL ?? new URL(request.url).origin;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }
  const { id } = await params;
  const client = await getScopedDb(session).clients.findById(id);
  if (!client) {
    return NextResponse.json({ error: "Müşteri bulunamadı" }, { status: 404 });
  }
  const users = await getAgencyPortalUsers(session).list(client.id);
  return NextResponse.json({ users });
}

export async function POST(request: Request, { params }: RouteParams) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  // Bu route müşteriye mail gönderiyor: CSRF'in bedeli ajans adına giden mail.
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  if (session.agencyRole !== "owner" && session.agencyRole !== "member") {
    return NextResponse.json({ error: "Bu işlem için yetkin yok" }, { status: 403 });
  }

  // Anahtar AJANS: aynı ajans farklı ağlardan aynı tavana çarpsın.
  if (await checkRateLimit(`portal-user-invite:${session.agencyId}`)) {
    return NextResponse.json(
      { error: "Çok fazla istek, biraz sonra tekrar deneyin" },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
  }
  const { email } = (body ?? {}) as { email?: unknown };
  const emailError = validateClientEmail(email);
  if (emailError) {
    return NextResponse.json({ error: emailError, field: "email" }, { status: 400 });
  }

  const { id } = await params;
  const client = await getScopedDb(session).clients.findById(id);
  if (!client) {
    return NextResponse.json({ error: "Müşteri bulunamadı" }, { status: 404 });
  }

  const result = await getAgencyPortalUsers(session).create(client.id, email as string);
  if (!result.ok) {
    if (result.reason === "client_not_found") {
      return NextResponse.json({ error: "Müşteri bulunamadı" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Bu e-posta zaten bir portal hesabında kayıtlı", field: "email" },
      { status: 409 }
    );
  }

  // Mail gitmese de kullanıcı kaydı duruyor: müşteri /portal/giris'ten kendi
  // linkini isteyebilir. Sonuç yanıta konuyor ki panel "mail gitmedi" diyebilsin.
  const { client: _client, ...user } = result.user;
  void _client;
  const mail = await issueLoginLink(result.user, appBaseUrl(request), true);
  return NextResponse.json({ user, emailSent: mail.sent }, { status: 201 });
}
