import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { portalMutationGuard, readJson } from "@/lib/portal-route";
import { validateDuplicateCheck } from "@/lib/portal-validation";
import type { DuplicateMatch, DuplicateWhere } from "@/lib/portal-duplicate";

/**
 * "Aynı video" kontrolü (2026-09-28 analizi, V7 tasarımı "Yükle · aynı video
 * uyarısı"). Seçilen dosyaların boyutları, bu müşterinin daha önce yüklediği
 * videolarla karşılaştırılır; eşleşen dosya yüklenmeden önce kullanıcıya
 * sorulur. Taslak üretmez, hiçbir şey yazmaz.
 *
 * POST (GET değil): liste gövdede; `portalMutationGuard`ın origin kontrolü
 * ve hız sınırı da işine yarıyor (her seçimde bir istek).
 *
 * Yanıt dosya sırasıyla hizalı: `matches[i]` i. dosyanın en yeni eşi ya da
 * `null`. Eşin nerede olduğu kullanıcıya söylenecek kadar — ham alanlar değil.
 */

export async function POST(request: Request) {
  const guard = await portalMutationGuard(request, { action: "upload-check" });
  if (!guard.ok) return guard.response;

  const parsed = validateDuplicateCheck(await readJson(request));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  }

  const scoped = getClientScopedDb(guard.session);
  const found = await scoped.posts.findBySourceSize([...new Set(parsed.files.map((f) => f.size))]);
  if (found.length === 0) {
    return NextResponse.json({ matches: parsed.files.map(() => null) });
  }

  // Kuyruk sırası yalnızca eş kuyruktaysa gerekiyor.
  const queue = found.some((post) => post.queuePosition !== null) ? await scoped.posts.listQueue() : [];
  const matches: (DuplicateMatch | null)[] = parsed.files.map((file) => {
    // `findBySourceSize` en yeniyi başta döndürüyor: aynı boyutta birden
    // fazla eş varsa en son yüklenen anlatılır.
    const twin = found.find((post) => post.sourceSize === file.size);
    if (!twin) return null;
    let where: DuplicateWhere;
    if (twin.publishStatus === "published" || twin.publishStatus === "duplicate") where = "published";
    else if (twin.status === "rejected") where = "rejected";
    else if (twin.queuePosition !== null) where = "queue";
    else where = "outside";
    const index = where === "queue" ? queue.findIndex((post) => post.id === twin.id) : -1;
    return {
      id: twin.id,
      createdAt: twin.createdAt.toISOString(),
      where,
      position: index >= 0 ? index + 1 : null,
    };
  });
  return NextResponse.json({ matches });
}
