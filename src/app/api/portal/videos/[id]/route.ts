import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { toDetail } from "@/lib/portal-media";
import { notFound, portalMutationGuard, portalReadGuard, readJson } from "@/lib/portal-route";
import { deleteObject, keyBelongsToClient, r2Configured } from "@/lib/storage-r2";
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

/**
 * "Kuyruk dışı" videoyu kalıcı siler (çıkarılan ya da reddedilen). Kuyruktaki,
 * yayınlanan/yayınlanmakta olan ve yüklemesi bitmemiş video 409 — koşul
 * `posts.deleteOutside`'da, tek transaction'da.
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "delete" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const scoped = getClientScopedDb(guard.session);
  const deleted = await scoped.posts.deleteOutside(id);
  if (!deleted) {
    const current = await scoped.posts.findById(id);
    if (!current) return notFound();
    return NextResponse.json(
      {
        error: "Yalnızca kuyruk dışındaki videolar silinebilir",
        publishStatus: current.publishStatus,
      },
      { status: 409 }
    );
  }

  // DB commit oldu; R2 artık yalnızca çöp. Hata yanıtı değiştirmez: kayıt
  // gitti, kullanıcıya "silinemedi" demek yalan olurdu — kalan nesne loglanır.
  await deleteVideoObjects(guard.session.clientId, deleted);
  return NextResponse.json({ ok: true });
}

async function deleteVideoObjects(
  clientId: string,
  keys: { videoKey: string | null; frameKeys: string[] }
): Promise<void> {
  if (!r2Configured()) return;
  const all = [keys.videoKey, ...keys.frameKeys].filter((key): key is string => !!key);
  // Anahtar DB'den geliyor ama başka müşterinin önekini gösteren bir değer,
  // o müşterinin nesnesini sildirmek demek olurdu (imzalı URL'deki kapının aynısı).
  const owned = all.filter((key) => keyBelongsToClient(key, clientId));
  if (owned.length !== all.length) {
    console.error(`[portal:delete] müşteri önekinde olmayan ${all.length - owned.length} anahtar atlandı`);
  }
  const results = await Promise.allSettled(owned.map((key) => deleteObject(key)));
  const failed = results.filter((r) => r.status === "rejected" || r.value === false).length;
  if (failed > 0) {
    console.error(`[portal:delete] R2'de ${failed}/${owned.length} nesne silinemedi`);
  }
}
