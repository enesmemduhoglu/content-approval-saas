import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { adNotFound, portalMutationGuard } from "@/lib/portal-route";

/**
 * V12 — "Tekrar dene": yayın hatası alan reklam `failed → idle`. Yayını burada
 * ÇALIŞTIRMAZ: reklam havuzdaki yerine döner ve bir sonraki reklam saatinde
 * (sayaç dolduysa) tick onu yeniden dener. Video retry'ının gerekçesi.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "ad-retry" });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const scoped = getClientScopedDb(guard.session);
  if (await scoped.ads.retry(id)) return NextResponse.json({ ok: true });
  const current = await scoped.ads.findState(id);
  if (!current) return adNotFound();
  return NextResponse.json(
    { error: "Bu reklam tekrar denenecek durumda değil", publishStatus: current.publishStatus },
    { status: 409 }
  );
}
