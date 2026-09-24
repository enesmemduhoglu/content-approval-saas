import { NextResponse } from "next/server";
import { runCaption } from "@/lib/caption/run";
import { authorizeQueueRequest, type CaptionJob } from "@/lib/qstash";

/**
 * Video kuyruğu (V2) — QStash'in yüklenen her video için bir kez çağırdığı
 * caption üretimi (K10). İş `runCaption`da; bu dosya yalnızca kapı ve
 * durum kodu çevirisi.
 *
 * ─── Durum kodları QStash'e verilen talimattır ─────────────────────────────
 * QStash 2xx dışındaki her yanıtı yeniden dener. Bu yüzden:
 *   • kalıcı durumlar (post yok, portal postu değil, iş zaten alınmış/bitmiş,
 *     çıktı kurallara uymadı) → 200 + açıklama; tekrar denemek aynı sonucu
 *     verir ve boşuna Whisper/Claude parası harcatır;
 *   • geçici dış hata (fal/Claude 5xx, ağ, zaman aşımı, DB) → 503; post
 *     `failed`de, kilit onu yeniden alabildiği için tekrar deneme işi
 *     kaldığı yerden sürdürür (transkript kayıtlıysa Whisper atlanır).
 *
 * Kullanıcı oturumu yok, `getScopedDb` yok: çağıran bir kullanıcı değil, imzalı
 * QStash mesajı (ya da CRON_SECRET'lı yedek tetikleyici). postId'yi yalnızca
 * mesajı imzalayan taraf, yani kendi `enqueueCaption`ımız seçebiliyor.
 * `checkOrigin` da yok: çerezle yetkilendirilen bir yol değil (makine yolu
 * muafiyeti, CLAUDE.md) — tarayıcı imza başlığını ya da Bearer'ı kendiliğinden
 * eklemez, CSRF'in dayandığı "otomatik gönderilen kimlik" burada yok.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ postId: string }> }
) {
  // Ham gövde imzanın parçası — JSON'a çevirmeden ÖNCE okunmalı (qstash.ts).
  const rawBody = await request.text();
  if (!(await authorizeQueueRequest(request, rawBody))) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }

  const { postId } = await params;

  let job: Partial<CaptionJob> = {};
  if (rawBody.trim()) {
    try {
      job = JSON.parse(rawBody) as Partial<CaptionJob>;
    } catch {
      // İmzalı ama bozuk gövde tekrar denemeyle düzelmez.
      return NextResponse.json({ ok: false, error: "Geçersiz gövde" });
    }
  }
  if (job.postId !== undefined && job.postId !== postId) {
    return NextResponse.json({ ok: false, error: "Gövdedeki postId adresle uyuşmuyor" });
  }
  const note = typeof job.note === "string" ? job.note : undefined;

  try {
    const outcome = await runCaption(postId, { note });
    if (outcome.status === "failed") {
      return NextResponse.json(
        { ok: false, status: outcome.status, reason: outcome.reason },
        { status: outcome.retryable ? 503 : 200 }
      );
    }
    if (outcome.status === "skipped") {
      return NextResponse.json({ ok: true, status: outcome.status, reason: outcome.reason });
    }
    // Yanıt caption metnini taşımaz: QStash panelinde/loglarında içerik
    // birikmesin, sonucu isteyen DB'den okur.
    return NextResponse.json({ ok: true, status: outcome.status });
  } catch (error) {
    // `runCaption` sözleşmesi "asla throw etmez"; buraya düşmek bir hata.
    console.error(`[queue:caption] ${postId} beklenmeyen hata:`, (error as Error).message);
    return NextResponse.json({ ok: false, error: "Beklenmeyen hata" }, { status: 500 });
  }
}
