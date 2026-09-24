import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard, readJson } from "@/lib/portal-route";
import { getClientIp } from "@/lib/rate-limit";

/**
 * Onay / red (portal). Onay yayın TETİKLEMEZ — ajansın onay linkinden farkı
 * tam olarak bu: portal postu kuyrukta slotunu bekler, yayını tick yapar
 * (README §8). Bu route `publish-post.ts`'i bilerek import etmiyor.
 *
 * Karar koşullu UPDATE ile (`status: pending`) ve `ApprovalAudit`e IP'yle
 * yazılır — anlaşmazlıkta bakılacak defter onay linkiyle aynı.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "decision" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const { action, reason } = ((await readJson(request)) ?? {}) as {
    action?: unknown;
    reason?: unknown;
  };
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "Geçersiz işlem", field: "action" }, { status: 400 });
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return NextResponse.json({ error: "Gerekçe metin olmalı", field: "reason" }, { status: 400 });
  }
  const rejectionReason =
    action === "reject" && typeof reason === "string" && reason.trim()
      ? reason.trim().slice(0, 2000)
      : null;

  const scoped = getClientScopedDb(guard.session);
  const ip = getClientIp(request.headers);
  const decided = await scoped.posts.decide(id, action, ip, rejectionReason);
  if (!decided) {
    const current = await scoped.posts.findById(id);
    if (!current) return notFound();
    const error =
      current.status === "pending" && action === "approve"
        ? "Caption hazır olmadan video onaylanamaz"
        : "Bu video için zaten karar verildi";
    return NextResponse.json({ error, status: current.status }, { status: 409 });
  }
  return NextResponse.json({ status: action === "approve" ? "approved" : "rejected" });
}
