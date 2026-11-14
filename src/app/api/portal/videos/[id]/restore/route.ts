import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { notFound, portalMutationGuard } from "@/lib/portal-route";
import { getClientIp } from "@/lib/rate-limit";

/**
 * Reddedilmiş videoyu kuyruğa geri al (portal). Portalda onay/red K33'le
 * kalktı, yeni red üretilmiyor; bu route yalnızca o tarihten ÖNCE reddedilmiş
 * ve hâlâ "Kuyruk dışı"nda duran videolar için var. Video kuyruğun sonuna
 * `pending` döner ve sırası gelince tick'in otomatik onayıyla yayınlanır.
 *
 * Gövde okunmuyor: K33 öncesi önbellekteki PWA `{ approve, position }`
 * gönderebilir, ikisi de artık anlamsız ve sessizce yok sayılır.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "restore" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const scoped = getClientScopedDb(guard.session);
  const restored = await scoped.posts.restoreRejected(id, getClientIp(request.headers));
  if (restored) return NextResponse.json({ status: "pending" });

  const current = await scoped.posts.findById(id);
  if (!current) return notFound();
  return NextResponse.json(
    { error: "Bu video reddedilmiş değil", status: current.status },
    { status: 409 }
  );
}
