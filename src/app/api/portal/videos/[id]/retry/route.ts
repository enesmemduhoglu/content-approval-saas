import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard } from "@/lib/portal-route";

/**
 * "Tekrar dene": yayın hatası alan video `failed → idle`. Yayını burada
 * ÇALIŞTIRMAZ — video kuyruktaki yerinde kalır ve bir sonraki slotta tick onu
 * yeniden dener. Anında yayın, kullanıcının seçtiği ritmi (slotları) delerdi.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "retry" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const scoped = getClientScopedDb(guard.session);
  if (await scoped.posts.retry(id)) return NextResponse.json({ ok: true });
  const current = await scoped.posts.findById(id);
  if (!current) return notFound();
  return NextResponse.json(
    { error: "Bu video tekrar denenecek durumda değil", publishStatus: current.publishStatus },
    { status: 409 }
  );
}
