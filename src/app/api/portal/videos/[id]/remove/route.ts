import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard } from "@/lib/portal-route";

/**
 * Kuyruktan çıkar: video silinmez, `queuePosition = null` olur ve tick onu
 * artık seçmez. Geri almak için "sona at". Yayın kilidi alınmışken 409.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "remove" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const scoped = getClientScopedDb(guard.session);
  if (await scoped.posts.removeFromQueue(id)) return NextResponse.json({ ok: true });
  const current = await scoped.posts.findById(id);
  if (!current) return notFound();
  return NextResponse.json(
    { error: "Bu video şu an kuyruktan çıkarılamaz", publishStatus: current.publishStatus },
    { status: 409 }
  );
}
