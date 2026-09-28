import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard, readJson } from "@/lib/portal-route";
import { getClientIp } from "@/lib/rate-limit";

/**
 * Reddi geri al (portal). Yanlışlıkla reddedilen video kuyruğa döner:
 *   • `approve: true`  → onaylı, sırası gelince yayınlanır (caption hazır olmalı),
 *   • `approve: false` → onay bekler (önce caption düzeltilecekse).
 * `position` verilirse video o sıraya döner — red kararının hemen ardından
 * "Geri al" (`/decision` yanıtındaki `previousPosition`); yoksa sona.
 *
 * `position` istemciden geliyor ama yalnızca müşterinin KENDİ kuyruğundaki
 * sıralamayı etkiler (kapsamlı UPDATE); sonlu bir sayı olması yeter.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "restore" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const { approve, position } = ((await readJson(request)) ?? {}) as {
    approve?: unknown;
    position?: unknown;
  };
  if (typeof approve !== "boolean") {
    return NextResponse.json({ error: "Geçersiz işlem", field: "approve" }, { status: 400 });
  }
  if (
    position !== undefined &&
    position !== null &&
    (typeof position !== "number" || !Number.isFinite(position))
  ) {
    return NextResponse.json({ error: "Geçersiz sıra", field: "position" }, { status: 400 });
  }

  const scoped = getClientScopedDb(guard.session);
  const restored = await scoped.posts.restoreRejected(id, {
    approve,
    position: typeof position === "number" ? position : null,
    ip: getClientIp(request.headers),
  });
  if (restored) return NextResponse.json({ status: approve ? "approved" : "pending" });

  const current = await scoped.posts.findById(id);
  if (!current) return notFound();
  const error =
    current.status === "rejected" && approve && current.captionStatus !== "ready"
      ? "Caption hazır olmadan video onaylanamaz"
      : "Bu video reddedilmiş değil";
  return NextResponse.json({ error, status: current.status }, { status: 409 });
}
