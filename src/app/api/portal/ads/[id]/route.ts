import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { adNotFound, portalMutationGuard, readJson } from "@/lib/portal-route";
import { validateAdCaption } from "@/lib/portal-validation";
import { deleteOwnedObjects } from "@/lib/r2-cleanup";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * V12 — reklama özel metin. Boş metin geçerli: "varsayılan reklam metnini
 * kullan" demek (yayın anında `prepareAdForPublish` boşu varsayılanla doldurur).
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "ad-caption" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const { caption } = ((await readJson(request)) ?? {}) as { caption?: unknown };
  const parsed = validateAdCaption(caption, { required: false });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: "caption" }, { status: 400 });
  }

  const scoped = getClientScopedDb(guard.session);
  if (await scoped.ads.updateCaption(id, parsed.caption)) return NextResponse.json({ ok: true });
  const current = await scoped.ads.findState(id);
  if (!current) return adNotFound();
  return NextResponse.json(
    { error: "Bu reklamın metni artık değiştirilemez", publishStatus: current.publishStatus },
    { status: 409 }
  );
}

/**
 * Yayınlanmamış reklamı kalıcı siler. Yayınlanan ya da şu an yayınlanan 409 —
 * koşul `ads.delete`'te, tek transaction'da.
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "ad-delete" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const scoped = getClientScopedDb(guard.session);
  const deleted = await scoped.ads.delete(id);
  if (!deleted) {
    const current = await scoped.ads.findState(id);
    if (!current) return adNotFound();
    return NextResponse.json(
      { error: "Yayınlanmış reklam silinemez", publishStatus: current.publishStatus },
      { status: 409 }
    );
  }
  // DB commit oldu; R2 artık yalnızca çöp (video silme yolunun gerekçesi).
  await deleteOwnedObjects(guard.session.clientId, [deleted.imageKey], "portal:ad-delete");
  return NextResponse.json({ ok: true });
}
