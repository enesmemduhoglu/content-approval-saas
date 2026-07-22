export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 10;

type FixedWindow = { count: number; windowStart: number };

// Bilinen kısıt: in-memory sayaç serverless instance'lar arasında paylaşılmaz
// (D4 kararı — MVP ölçeği için kabul edildi, bkz. TODOS.md / Upstash).
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

// `x-forwarded-for` yoksa (yerel geliştirme, proxy'siz ortam) sessiz boş değer yerine
// "unknown" sabitine düşer — audit kayıtları hiçbir zaman boş IP içermez (TENSION 4).
export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  const first = forwarded.split(",")[0]?.trim();
  return first || "unknown";
}
