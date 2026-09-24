import { NextResponse } from "next/server";
import { getClientSession, type ClientSession } from "@/lib/client-auth";
import { checkOrigin } from "@/lib/origin";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Video kuyruğu (V3) — portal mutasyon route'larının ortak kapısı.
 *
 * CLAUDE.md'deki sabit sıra, müşteri oturumuna uyarlanmış hâliyle:
 *   1. oturum (imzalı çerez + `ClientUser` hâlâ var mı) → 401
 *   2. `checkOrigin` → 403. Portal yolu TAMAMEN çerezli; makine yolu yok, yani
 *      muafiyet de yok.
 *   3. rol → portalda tek rol var (müşteri kullanıcısı); adım bilerek boş.
 *   4. `checkRateLimit` → 429. Anahtar MÜŞTERİ (hesap), IP değil: aynı
 *      müşterinin telefonu ve bilgisayarı aynı tavana çarpsın.
 *   5–6. gövde doğrulaması ve kapsamlı sorgu route'un kendisinde.
 *
 * Tek fonksiyonda toplanmasının sebebi sıranın tek yerde durması: 12 route'ta
 * elle tekrarlanan sıra, birinde yer değiştirmeye en açık kod.
 */

/** Portal kullanıcısı kuyruğu sürükleyerek dizerken dakikada onlarca istek atabilir. */
export const PORTAL_RATE_LIMIT_MAX = 60;

export type PortalGuard =
  | { ok: true; session: ClientSession }
  | { ok: false; response: NextResponse };

export async function portalMutationGuard(
  request: Request,
  opts: { action: string; max?: number; rateKeySuffix?: string }
): Promise<PortalGuard> {
  const session = await getClientSession(request);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "Giriş gerekli" }, { status: 401 }) };
  }
  const origin = checkOrigin(request);
  if (!origin.ok) {
    return { ok: false, response: NextResponse.json({ error: origin.message }, { status: 403 }) };
  }
  const key = `portal:${opts.action}:${session.clientId}`;
  if (await checkRateLimit(key, Date.now(), opts.max ?? PORTAL_RATE_LIMIT_MAX)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Çok fazla istek, biraz sonra tekrar deneyin" },
        { status: 429 }
      ),
    };
  }
  return { ok: true, session };
}

/** Okuma yolları yalnızca oturum ister (GET yan etkisiz, CSRF'in konusu değil). */
export async function portalReadGuard(request: Request): Promise<PortalGuard> {
  const session = await getClientSession(request);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "Giriş gerekli" }, { status: 401 }) };
  }
  return { ok: true, session };
}

export async function readJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export const notFound = () => NextResponse.json({ error: "Video bulunamadı" }, { status: 404 });
