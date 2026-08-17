import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";

/**
 * Müşteri silme (F2).
 *
 * Postu olan müşteri silinmez. `Post.clientId` FK'sı zaten engellerdi ama o yol
 * çıplak bir Prisma hatasıyla 500 dönerdi; burada sebep açıkça söyleniyor ve
 * kaç post olduğu bildiriliyor ki ajans ne yapması gerektiğini bilsin.
 *
 * Silme, müşterinin Instagram kimlik bilgilerini de götürür (aynı satırda
 * duruyorlar) — ayrıca bağlantı kaldırmaya gerek yok.
 */

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: RouteParams) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  const { id } = await params;
  const result = await getScopedDb(session).clients.deleteById(id);

  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "Bu müşteri bulunamadı" }, { status: 404 });
    }
    return NextResponse.json(
      {
        error:
          `Bu müşterinin ${result.postCount} postu var. Önce postları sil, ` +
          "sonra müşteriyi silebilirsin.",
        postCount: result.postCount,
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true });
}
