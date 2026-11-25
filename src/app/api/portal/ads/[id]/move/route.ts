import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { adNotFound, portalMutationGuard, readJson } from "@/lib/portal-route";
import { validateMoveTarget } from "@/lib/portal-validation";

/**
 * V12c — reklam havuzunda taşıma (portalda basılı tutup sürükleme). Video
 * `move` route'unun birebir deseni: gövde `{ beforeId?, afterId? }`, yeni
 * konum komşuların ortalaması, float çözünürlüğü tükenirse havuz yeniden
 * numaralanır (portal-order.ts). Komşular kapsamlı sorgudan çözülür.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "ad-move" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const target = validateMoveTarget(await readJson(request));
  if (!target.ok) {
    return NextResponse.json({ error: target.error, field: target.field }, { status: 400 });
  }

  const result = await getClientScopedDb(guard.session).ads.move(id, {
    beforeId: target.beforeId,
    afterId: target.afterId,
  });
  if (result.ok) return NextResponse.json({ ok: true });
  if (result.reason === "not_found") return adNotFound();
  if (result.reason === "self") {
    return NextResponse.json({ error: "Reklam kendi yanına taşınamaz" }, { status: 400 });
  }
  // Komşu havuzda yok ya da artık yan yana değil: istemcinin listesi bayat.
  return NextResponse.json(
    { error: "Havuz bu arada değişti, sayfayı yenileyip tekrar dene" },
    { status: 409 }
  );
}
