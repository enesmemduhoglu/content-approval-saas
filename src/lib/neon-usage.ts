import { sendAlert } from "@/lib/alerts";

/**
 * V11 — Neon compute kotası dolmadan haber ver.
 *
 * 2026-10'da ücretsiz planın 100 CU-saatlik aylık kotası ayın 19'unda bitti
 * ve ürün sessizce 11 gün kapalı kaldı: ilk sinyal kota bittikten SONRA
 * gelen "DB'ye ulaşılamıyor" uyarılarıydı. Bu kontrol günlük cron'da,
 * DB'den bağımsız (Neon API) çalışır ve eşik geçilince bir uyarı atar.
 *
 * Alan: proje nesnesindeki `compute_time_seconds` — compute boyutuyla
 * ağırlıklı süre (CU-saniye), yani kotanın birimi. `active_time_seconds`
 * compute boyutunu bilmez, `cpu_used_sec` gerçek CPU'dur; ikisi de kotayı
 * ölçmez. Neon bu metriklerin faturalama için olmadığını söylüyor
 * (faturalama: `consumption_history`); erken uyarı için yeterince yakın.
 *
 * `NEON_API_KEY` ya da `NEON_PROJECT_ID` yoksa sessizce atlanır (env deseni:
 * çekirdek akış Neon API'si olmadan da çalışır). ASLA throw etmez.
 */

const NEON_API = "https://console.neon.tech/api/v2";
const REQUEST_TIMEOUT_MS = 10_000;

/** Ücretsiz planın proje başına aylık kotası (CU-saat); plan değişirse env ile ezilir. */
export const DEFAULT_CU_HOURS_QUOTA = 100;
/** Bu oran geçilince uyarı — 7/24 açık compute'la bile kotanın bitmesine birkaç gün kalır. */
export const USAGE_ALERT_RATIO = 0.7;

export type NeonUsageResult =
  | { ok: true; cuHours: number; quota: number; ratio: number; alerted: boolean }
  | { ok: false; skipped?: string; error?: string };

function quota(): number {
  const raw = Number(process.env.NEON_CU_HOURS_QUOTA);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CU_HOURS_QUOTA;
}

export async function checkNeonUsage(): Promise<NeonUsageResult> {
  const apiKey = process.env.NEON_API_KEY;
  const projectId = process.env.NEON_PROJECT_ID;
  if (!apiKey || !projectId) {
    return { ok: false, skipped: "NEON_API_KEY ya da NEON_PROJECT_ID tanımlı değil" };
  }
  try {
    const res = await fetch(`${NEON_API}/projects/${encodeURIComponent(projectId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[neon-usage] Neon API ${res.status} döndü`);
      return { ok: false, error: `Neon API ${res.status}` };
    }
    const data = (await res.json()) as { project?: { compute_time_seconds?: unknown } };
    const seconds = data.project?.compute_time_seconds;
    if (typeof seconds !== "number") {
      return { ok: false, error: "compute_time_seconds yok" };
    }

    const cuHours = seconds / 3600;
    const limit = quota();
    const ratio = cuHours / limit;
    const alerted = ratio >= USAGE_ALERT_RATIO;
    if (alerted) {
      await sendAlert("neon:usage", "Neon compute kotası dolmak üzere", {
        kullanilan_cu_saat: Math.round(cuHours * 10) / 10,
        kota_cu_saat: limit,
        oran: `%${Math.round(ratio * 100)}`,
        yapilacak:
          "Kota dolarsa tüm ürün kapanır. Neon konsolunda kullanım grafiğine bak: compute uyumuyorsa sık tetiklenen bir iş var (2026-10: 5 dk'lık tick).",
      });
    }
    return { ok: true, cuHours, quota: limit, ratio, alerted };
  } catch (error) {
    // Hata metni yalnızca mesaj — istek başlığındaki anahtar hiçbir yere yazılmaz.
    console.error("[neon-usage] kontrol başarısız:", (error as Error).message);
    return { ok: false, error: "istek başarısız" };
  }
}
