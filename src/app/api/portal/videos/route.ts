import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { toCard } from "@/lib/portal-media";
import { portalReadGuard } from "@/lib/portal-route";

/**
 * Video kuyruğu (V3) — portalın liste görünümü: kuyruk, kuyruk dışı ve geçmiş.
 * Kapak kareleri imzalı GET URL'i olarak döner; ham R2 anahtarı yanıta çıkmaz.
 */
export async function GET(request: Request) {
  const guard = await portalReadGuard(request);
  if (!guard.ok) return guard.response;
  const { clientId } = guard.session;

  const scoped = getClientScopedDb(guard.session);
  const [queue, outside, history] = await Promise.all([
    scoped.posts.listQueue(),
    scoped.posts.listOutside(),
    scoped.posts.listHistory(),
  ]);
  const cards = (list: typeof queue) => Promise.all(list.map((v) => toCard(v, clientId)));

  return NextResponse.json({
    queue: await cards(queue),
    outside: await cards(outside),
    history: await cards(history),
  });
}
