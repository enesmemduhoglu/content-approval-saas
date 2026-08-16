import { createHash, timingSafeEqual } from "node:crypto";
import type { ScopedSession } from "@/lib/scoped-db";

/**
 * Makine erişimi: bulut rutinleri (furi) OAuth akışı yürütemez, bu yüzden
 * `Authorization: Bearer <key>` ile kimlik doğrular.
 *
 * Anahtar YALNIZCA `agencyId` üretir — sorgular yine `getScopedDb()` üzerinden
 * gider. `scoped-db.ts`'deki "route handler'lar bu modeller için ham `db.*`
 * çağırmaz" kuralı, dolayısıyla IDOR koruması, aynen geçerli kalır.
 */

/** Anahtar kısa olursa brute-force anlamlı hale gelir; kurulum hatasını sessizce geçme. */
export const MIN_API_KEY_LENGTH = 32;

function configured(): { key: string; agencyId: string } | null {
  const key = process.env.FURI_API_KEY;
  const agencyId = process.env.FURI_API_AGENCY_ID;
  if (!key || !agencyId) return null;
  if (key.length < MIN_API_KEY_LENGTH) {
    console.error(
      `[api-key] FURI_API_KEY en az ${MIN_API_KEY_LENGTH} karakter olmalı — anahtar devre dışı`
    );
    return null;
  }
  return { key, agencyId };
}

/**
 * Timing-safe karşılaştırma. Uzunluk farkı `timingSafeEqual`'ı patlattığı ve
 * uzunluğun kendisi de bilgi sızdırdığı için iki taraf da önce SHA-256'dan
 * geçirilir — karşılaştırma her zaman sabit 32 bayt üzerinde yapılır.
 */
function secretsMatch(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Geçerli API anahtarı için `{ agencyId }`, aksi halde `null` döner.
 * `null` dönmesi 401 anlamına gelir — çağıran taraf karar verir.
 */
export async function authenticateApiKey(request: Request): Promise<ScopedSession | null> {
  const config = configured();
  if (!config) return null;

  const presented = bearerToken(request);
  if (!presented) return null;

  if (!secretsMatch(presented, config.key)) return null;
  return { agencyId: config.agencyId };
}
