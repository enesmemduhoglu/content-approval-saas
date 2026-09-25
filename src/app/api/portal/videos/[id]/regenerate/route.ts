import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard, readJson } from "@/lib/portal-route";
import { validateRegenerateNote } from "@/lib/portal-validation";
import { enqueueCaption } from "@/lib/qstash";

/**
 * Caption'ı yeniden ürettirir; isteğe bağlı not ("daha kısa olsun") QStash
 * mesajıyla caption işine taşınır. Transkript ve kareler yeniden kullanılır
 * (README §3.5) — bu route yalnızca durumu `pending`e çekip işi kuyruğa atar.
 *
 * Elle yapılmış düzenleme üzerine yazılır; arayüz bunu onay adımıyla söylüyor
 * (KARARLAR "Açık sorular").
 */

/** Claude çağrısı para harcıyor: dakikalık tavan genel portal tavanından dar. */
const REGENERATE_RATE_MAX = 10;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, {
    action: "regenerate",
    max: REGENERATE_RATE_MAX,
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const { note } = ((await readJson(request)) ?? {}) as { note?: unknown };
  const parsed = validateRegenerateNote(note);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  }

  const scoped = getClientScopedDb(guard.session);
  if (!(await scoped.posts.requestRegenerate(id))) {
    const current = await scoped.posts.findById(id);
    if (!current) return notFound();
    return NextResponse.json(
      {
        error:
          current.captionStatus === "pending" || current.captionStatus === "generating"
            ? "Caption zaten hazırlanıyor"
            : "Bu videonun caption'ı artık yeniden üretilemez",
        captionStatus: current.captionStatus,
      },
      { status: 409 }
    );
  }

  const enqueue = await enqueueCaption(id, parsed.note ? { note: parsed.note } : {});
  if (!enqueue.queued) {
    console.error(`[portal-regenerate] caption kuyruğa atılamadı (post=${id}): ${enqueue.reason}`);
  }
  return NextResponse.json({ ok: true, captionQueued: enqueue.queued });
}
