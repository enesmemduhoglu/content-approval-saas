export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 10;

type FixedWindow = { count: number; windowStart: number };

// In-memory sayaç serverless instance'lar arasında paylaşılmaz — Upstash env
// değişkenleri varsa checkRateLimit dağıtık sayaca geçer (D4 / TODOS kapanışı),
// yoksa veya Upstash hata verirse bu in-memory fallback devrededir.
const windows = new Map<string, FixedWindow>();

export function isRateLimited(ip: string, now: number = Date.now()): boolean {
  if (windows.size > 10_000) pruneStaleWindows(now);
  const current = windows.get(ip);
  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    windows.set(ip, { count: 1, windowStart: now });
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT_MAX;
}

function pruneStaleWindows(now: number): void {
  for (const [key, value] of windows) {
    if (now - value.windowStart >= RATE_LIMIT_WINDOW_MS) windows.delete(key);
  }
}

export function resetRateLimiter(): void {
  windows.clear();
}

// Vercel Marketplace'in Upstash KV entegrasyonu KV_REST_API_* adlarını kullanır;
// doğrudan Upstash kurulumu UPSTASH_REDIS_REST_* verir. İkisi de desteklenir.
function upstashConfig(): { baseUrl: string; token: string } | null {
  const baseUrl =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

// Upstash Redis REST ile sabit pencere: INCR + ilk istekte EXPIRE.
// Bağımlılık eklememek için @upstash/redis yerine REST pipeline kullanılır.
async function isRateLimitedUpstash(
  ip: string,
  now: number,
  { baseUrl, token }: { baseUrl: string; token: string }
): Promise<boolean> {
  const windowId = Math.floor(now / RATE_LIMIT_WINDOW_MS);
  const key = `rl:${ip}:${windowId}`;
  const ttlSeconds = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);

  const res = await fetch(`${baseUrl}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["INCR", key],
      ["EXPIRE", key, String(ttlSeconds), "NX"],
    ]),
  });
  if (!res.ok) {
    throw new Error(`Upstash pipeline ${res.status}`);
  }
  const results = (await res.json()) as { result?: unknown }[];
  const count = Number(results?.[0]?.result ?? 0);
  return count > RATE_LIMIT_MAX;
}

/**
 * Route handler'ların kullandığı asıl giriş noktası. Upstash yapılandırılmışsa
 * dağıtık sayaç; değilse (veya Upstash erişilemezse) in-memory fallback —
 * rate limiting hiçbir durumda isteği patlatmaz, en kötü ihtimalle tek
 * instance'lık korumaya düşer.
 */
export async function checkRateLimit(ip: string, now: number = Date.now()): Promise<boolean> {
  const config = upstashConfig();
  if (config) {
    try {
      return await isRateLimitedUpstash(ip, now, config);
    } catch (error) {
      console.error("[rate-limit] Upstash hatası, in-memory fallback:", error);
    }
  }
  return isRateLimited(ip, now);
}

// Öncelik `x-vercel-forwarded-for`'da: bu başlığı Vercel'in kendi edge katmanı
// yazar ve istemci tarafından ÜZERİNE YAZILAMAZ (Vercel istemciden gelen aynı
// adlı başlığı siler/yeniden yazar). `x-forwarded-for` standart bir proxy
// başlığıdır — bugün Vercel'in dışına sızmıyor çünkü platform onu da kendi
// yazıyor, ama bu garanti Vercel'e ÖZGÜ: proje başka bir platforma taşınır ya
// da araya güvenilmeyen bir proxy girerse istemci bu başlığı sahteleyip hem
// rate limit'i atlatabilir hem de `ApprovalAudit.ip` içine (bir onayın kanıtı
// olarak saklanan) sahte bir IP yazdırabilir. Bu yüzden Vercel'e özgü, sahte
// lenemeyen başlık öncelikli; `x-forwarded-for` yalnızca ondan yoksun ortamlar
// (yerel geliştirme, Vercel dışı barındırma) için geriye dönük fallback.
// Hiçbiri yoksa sessiz boş değer yerine "unknown" sabitine düşer — audit
// kayıtları hiçbir zaman boş IP içermez (TENSION 4).
export function getClientIp(headers: Headers): string {
  const vercelForwarded = headers.get("x-vercel-forwarded-for");
  const vercelFirst = vercelForwarded?.split(",")[0]?.trim();
  if (vercelFirst) return vercelFirst;

  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  const first = forwarded.split(",")[0]?.trim();
  return first || "unknown";
}
