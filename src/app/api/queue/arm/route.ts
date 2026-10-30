import { NextResponse } from "next/server";
import { authorizeQueueRequest } from "@/lib/qstash";
import { syncQueueWakes } from "@/lib/queue-wake";

/**
 * V11 — slot uyandırmalarını ELLE kur/eşitle. Normalde ayar kaydı ve günlük
 * `pending-reminders` cron'u bunu yapıyor; bu uç ilk kurulum (deploy sonrası,
 * 5 dakikalık QStash zamanlaması silinmeden ÖNCE) ve onarım için:
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" $APP_URL/api/queue/arm
 *
 * Kapı tick'inkiyle aynı (QStash imzası ya da `Bearer CRON_SECRET`); çerez
 * okumadığı için `checkOrigin` yok — tarayıcı cross-site istekte
 * `Authorization` başlığını kendiliğinden eklemez (makine yolu muafiyeti). Yalnızca
 * POST: GET'le tetiklenebilen bir mutasyon, bir bağlantı önizleyicisinin
 * bile mesaj kurmasına yol açardı.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!(await authorizeQueueRequest(request, rawBody))) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }
  // Yanıt yalnızca sayı — müşteri ya da saat bilgisi loglara düşmez.
  const result = await syncQueueWakes();
  return NextResponse.json({ ok: result.failed === 0 && !result.skipped, ...result });
}
