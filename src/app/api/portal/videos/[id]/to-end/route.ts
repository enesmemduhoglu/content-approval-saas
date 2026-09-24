import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard } from "@/lib/portal-route";

/**
 * "Sona at": videoyu kuyruğun sonuna taşır (hata almışsa yeniden denenecek
 * hâle getirerek). Kuyruktan çıkarılmış videoyu geri almanın yolu da bu.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "to-end" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const scoped = getClientScopedDb(guard.session);
  if (await scoped.posts.moveToEnd(id)) return NextResponse.json({ ok: true });
  const current = await scoped.posts.findById(id);
  if (!current) return notFound();
  return NextResponse.json(
    { error: "Bu video kuyruğa alınamaz", status: current.status },
    { status: 409 }
  );
}
