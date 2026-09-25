import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { toDetail } from "@/lib/portal-media";
import { notFound, portalMutationGuard, portalReadGuard, readJson } from "@/lib/portal-route";
import { validateCaption } from "@/lib/validation";

type RouteParams = { params: Promise<{ id: string }> };

/** Video detayı: oynatıcı için imzalı video URL'i + kareler. */
export async function GET(request: Request, { params }: RouteParams) {
  const guard = await portalReadGuard(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const video = await getClientScopedDb(guard.session).posts.findById(id);
  // Başka müşterinin videosu "yok" ile aynı yanıtı alır: 403 demek, id'nin
  // var olduğunu doğrulamak olurdu.
  if (!video) return notFound();
  return NextResponse.json({ video: await toDetail(video, guard.session.clientId) });
}

/** Caption'ı elle düzenler. Üretim sürerken 409 — bkz. `posts.updateCaption`. */
export async function PATCH(request: Request, { params }: RouteParams) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "caption" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const { caption } = ((await readJson(request)) ?? {}) as { caption?: unknown };
  const captionError = validateCaption(caption);
  if (captionError) {
    return NextResponse.json({ error: captionError, field: "caption" }, { status: 400 });
  }

  const scoped = getClientScopedDb(guard.session);
  const updated = await scoped.posts.updateCaption(id, (caption as string).trim());
  if (!updated) {
    const current = await scoped.posts.findById(id);
    if (!current) return notFound();
    return NextResponse.json(
      {
        error:
          current.captionStatus === "pending" || current.captionStatus === "generating"
            ? "Caption şu an hazırlanıyor; bitince düzenleyebilirsin"
            : "Bu videonun caption'ı artık değiştirilemez",
        captionStatus: current.captionStatus,
      },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
