import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { checkOrigin } from "@/lib/origin";

/**
 * F6 — bekleyen daveti iptal eder.
 *
 * Neden gerekli: yanlış adrese gönderilmiş bir daveti geri almanın başka yolu
 * yok; davet 7 gün boyunca kabul edilebilir durumda kalırdı. Bir de bekleyen
 * davet tavanını (F7 deseni) serbest bırakmanın tek yolu bu.
 *
 * Kabul EDİLMİŞ davet silinmez (bkz. `invites.cancelById`): o satır artık
 * "kim ne zaman katıldı" kaydı.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  if (session.agencyRole !== "owner") {
    return NextResponse.json(
      { error: "Yalnızca ajans sahibi daveti iptal edebilir" },
      { status: 403 }
    );
  }

  const { id } = await params;
  const removed = await getScopedDb(session).invites.cancelById(id);
  if (!removed) {
    return NextResponse.json({ error: "Davet bulunamadı" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
