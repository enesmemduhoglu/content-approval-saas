import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard, readJson } from "@/lib/portal-route";
import { validateMoveTarget } from "@/lib/portal-validation";

/**
 * Kuyrukta taşıma. Gövde: `{ beforeId?, afterId? }` — "şu videonun önüne /
 * arkasına". Yeni konum komşuların ortalaması; float çözünürlüğü tükenirse
 * kuyruk yeniden numaralanır (bkz. portal-order.ts).
 *
 * Komşu id'leri de kapsamlı sorgudan çözülüyor: başka müşterinin videosunu
 * komşu göstermek "komşu bulunamadı"ya düşer, hiçbir satıra dokunmaz.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "move" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const target = validateMoveTarget(await readJson(request));
  if (!target.ok) {
    return NextResponse.json({ error: target.error, field: target.field }, { status: 400 });
  }

  const result = await getClientScopedDb(guard.session).posts.move(id, {
    beforeId: target.beforeId,
    afterId: target.afterId,
  });
  if (result.ok) return NextResponse.json({ ok: true });
  if (result.reason === "not_found") return notFound();
  if (result.reason === "self") {
    return NextResponse.json({ error: "Video kendi yanına taşınamaz" }, { status: 400 });
  }
  // Komşu kuyrukta yok ya da artık yan yana değil: istemcinin listesi bayat.
  return NextResponse.json(
    { error: "Kuyruk bu arada değişti, sayfayı yenileyip tekrar dene" },
    { status: 409 }
  );
}
