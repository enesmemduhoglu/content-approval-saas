import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { portalMutationGuard, readJson } from "@/lib/portal-route";
import { FRAME_COUNT, validateUploadFiles } from "@/lib/portal-validation";
import { frameKey, r2Configured, signPutUrl } from "@/lib/storage-r2";

/**
 * Video kuyruğu (V3) — yükleme başlatma (README §7 "Yükle" 1. adım).
 *
 * Dosya başına bir taslak post + R2'ye doğrudan PUT için imzalı URL'ler döner
 * (video + 6 kare). Dosyanın kendisi bu fonksiyondan GEÇMEZ: Vercel'in 4.5 MB
 * gövde sınırı var, video 300 MB olabilir.
 *
 * Toplu yükleme TEK istekte başlar (20 dosyaya kadar): dosya başına istek
 * atılsaydı 20 videoluk bir yükleme hız sınırına tek başına çarpardı.
 */

/**
 * Müşteri başına 24 saatlik yükleme tavanı. Hız sınırı dakikayı korur; bu
 * tavan günü korur — sızmış bir portal oturumunun R2'nin 10 GB ücretsiz
 * katmanını bir gecede doldurmasını engelleyen şey bu.
 */
function dailyUploadLimit(): number {
  const raw = Number(process.env.PORTAL_DAILY_UPLOAD_LIMIT);
  return Number.isInteger(raw) && raw > 0 ? raw : 40;
}

export async function POST(request: Request) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "upload" });
  if (!guard.ok) return guard.response;

  // Depolama yoksa yükleme AÇIK bir hatayla kapalı (CLAUDE.md: sessiz değil).
  // Taslak üretmeden önce: imzalayamayacağımız bir post DB'de öksüz kalmasın.
  if (!r2Configured()) {
    return NextResponse.json(
      { error: "Video depolama henüz yapılandırılmadı, ajansınla iletişime geç" },
      { status: 503 }
    );
  }

  const parsed = validateUploadFiles(await readJson(request));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  }

  const scoped = getClientScopedDb(guard.session);

  // Kota deseni (F7): 429 değil 403 — bu bir hız sınırı değil, tavan. Say-sonra-
  // yaz yarışa açık (iki eşzamanlı istek tavanı birkaç dosya aşabilir);
  // amaç kötüye kullanımı durdurmak, tek dosyayı bile geçirmemek değil.
  const limit = dailyUploadLimit();
  const used = await scoped.posts.countCreatedSince(new Date(Date.now() - 24 * 60 * 60 * 1000));
  if (used + parsed.files.length > limit) {
    return NextResponse.json(
      {
        error: `Günlük yükleme tavanı ${limit} video. Bugün ${Math.max(limit - used, 0)} video daha yükleyebilirsin.`,
        field: "files",
      },
      { status: 403 }
    );
  }

  const drafts = await scoped.posts.createDrafts(parsed.files);

  // İmzalar DB'deki anahtardan üretiliyor, istemcinin beyanından değil; kare
  // anahtarları da aynı müşteri önekinde (`frameKey`).
  const items = await Promise.all(
    drafts.map(async (draft, index) => ({
      postId: draft.id,
      videoPutUrl: await signPutUrl(draft.videoKey, parsed.files[index].contentType),
      framePutUrls: await Promise.all(
        Array.from({ length: FRAME_COUNT }, (_, i) =>
          signPutUrl(frameKey(guard.session.clientId, draft.id, i), "image/jpeg")
        )
      ),
    }))
  );

  return NextResponse.json({ items }, { status: 201 });
}
