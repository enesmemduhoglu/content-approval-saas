import { Prisma } from "@prisma/client";
import { sendAlert } from "@/lib/alerts";

/**
 * V11 — "veritabanına ulaşılamıyor"un gerçek sebebi.
 *
 * Neon ücretsiz planın kotası 2026-10-19'da dolunca Prisma yalnızca P1001
 * ("Can't reach database server") dedi; TCP bağlantısı açıldığı için ağ
 * sorunu gibi göründü. Sebep (402 "exceeded the quota") yalnızca Neon'un HTTP
 * SQL ucundan okunabiliyor. 11 gün boyunca gelen 400+ genel "çöktü" maili
 * kimseye bunu söylemedi; kota dolduysa tek, ne yapılacağını söyleyen bir
 * uyarı gitmeli.
 */

export type NeonProbe = "quota_exceeded" | "reachable" | "unknown";

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Uygulamanın GERÇEKTEN bağlandığı Neon; Neon olmayan (yerel/test) adreste
 * `null` — yoklanacak bir şey yok. `DATABASE_URL` önce: Prisma onu kullanıyor,
 * yerelde ise `POSTGRES_URL` prod'u gösteriyor (CLAUDE.md Tuzaklar) — yerel
 * bir P1001 için prod yoklanıp "ürün kapalı" uyarısı atılmasın.
 */
function neonConnection(): { host: string; url: string } | null {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".neon.tech") ? { host, url } : null;
  } catch {
    return null;
  }
}

/** Prisma'nın "sunucuya ulaşılamıyor" hatası mı (P1001)? */
export function isUnreachableDbError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError && error.errorCode === "P1001") {
    return true;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P1001") {
    return true;
  }
  // `findMany()` gibi bir çağrının içinden gelen hata her zaman yukarıdaki
  // sınıflarla gelmiyor; metin Prisma sürümleri arasında sabit.
  return error instanceof Error && error.message.includes("Can't reach database server");
}

/**
 * Neon'un HTTP ucuna `SELECT 1`. Throw etmez. Bağlantı adresi yalnızca
 * Neon'un kendi ucuna, kendi başlığında gider; hiçbir log ya da uyarıya
 * yazılmaz.
 */
export async function probeNeon(): Promise<NeonProbe> {
  const conn = neonConnection();
  if (!conn) return "unknown";
  try {
    const res = await fetch(`https://${conn.host}/sql`, {
      method: "POST",
      headers: { "Neon-Connection-String": conn.url, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "SELECT 1", params: [] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return "reachable";
    const text = await res.text().catch(() => "");
    if (res.status === 402 || text.includes("exceeded the quota")) return "quota_exceeded";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Kota uyarısının SABİT anahtarı — hangi iş patlarsa patlasın aynı bastırma penceresine düşsün. */
export const NEON_QUOTA_ALERT_KEY = "db:neon-quota";

/**
 * Tick/cron'ların crash dalı. DB'ye ulaşılamıyorsa önce sebep yoklanır:
 * kota dolduysa genel uyarı yerine tek bir "kota doldu" uyarısı gider. Aksi
 * hâlde eski davranış (`sendAlert(key, title, {error})`). ASLA throw etmez.
 */
export async function reportCrash(key: string, title: string, error: unknown): Promise<void> {
  try {
    if (isUnreachableDbError(error) && (await probeNeon()) === "quota_exceeded") {
      await sendAlert(NEON_QUOTA_ALERT_KEY, "Neon kotası doldu — tüm ürün kapalı", {
        kaynak: key,
        durum:
          "Neon ücretsiz planın aylık compute kotası bitti; panel, portal, onay linkleri ve kuyruk çalışmıyor.",
        yapilacak:
          "Neon konsolunda kullanımı kontrol et. Ya fatura dönemi başını bekle ya da ücretli plana geçip kapatmayı hemen kaldır.",
      });
      return;
    }
  } catch {
    // Teşhis patlarsa aşağıdaki genel uyarıya düş.
  }
  await sendAlert(key, title, {
    error: error instanceof Error ? error.message : String(error),
  });
}
