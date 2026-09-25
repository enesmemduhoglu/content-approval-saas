import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { getAgencyPortalUsers } from "@/lib/portal-users";
import { checkOrigin } from "@/lib/origin";

/**
 * Video kuyruğu (V3) — müşterinin portal erişimini kaldırır. Açık oturumlar
 * bir sonraki istekte düşer (bkz. `getClientSession`).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }
  if (session.agencyRole !== "owner" && session.agencyRole !== "member") {
    return NextResponse.json({ error: "Bu işlem için yetkin yok" }, { status: 403 });
  }

  const { id, userId } = await params;
  const client = await getScopedDb(session).clients.findById(id);
  if (!client) {
    return NextResponse.json({ error: "Müşteri bulunamadı" }, { status: 404 });
  }
  const removed = await getAgencyPortalUsers(session).remove(client.id, userId);
  if (!removed) {
    return NextResponse.json({ error: "Kullanıcı bulunamadı" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
