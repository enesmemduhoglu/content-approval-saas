import { ApiError, createFalClient, type FalClient } from "@fal-ai/client";
import { CaptionStepError, isRetryableStatus, safeDetail } from "./errors";

/**
 * Video kuyruğu (V2) — fal.ai Whisper ile transkript.
 *
 * Model `fal-ai/whisper`. `fal-ai/wizper` KULLANILMAZ: `chunk_level` için
 * yalnızca "segment" kabul ediyor ve pratikte tüm videoyu tek dev parça olarak
 * döndürüyor (subtitle-pipeline'da yaşandı). Bugün yalnızca düz metin
 * kullanılıyor ama parçalar da dönüyor; sessiz aralıkların ayıklanması ya da
 * zaman damgalı bir kullanım gelirse model değişmeden hazır olsun.
 *
 * Girdi R2'nin imzalı GET URL'i — dosya sunucudan geçmiyor, fal kendisi
 * indiriyor. Dil sabitlenmez: sayfa Türkçe anlatıp İngilizce örnek veriyor,
 * sabit `tr` İngilizce cümleleri Türkçe harflerle "duyabilirdi".
 */

export const WHISPER_MODEL = "fal-ai/whisper";

export type TranscriptChunk = { text: string; start: number | null; end: number | null };
export type Transcript = { text: string; chunks: TranscriptChunk[] };

let cached: FalClient | null = null;

function falClient(): FalClient {
  if (cached) return cached;
  const key = process.env.FAL_KEY;
  if (!key) {
    throw new CaptionStepError({
      step: "config",
      retryable: false,
      publicReason: "Transkript servisi yapılandırılmamış",
      detail: "FAL_KEY tanımlı değil",
    });
  }
  cached = createFalClient({ credentials: key });
  return cached;
}

/** Testlerin env değiştirdikten sonra istemciyi sıfırlayabilmesi için. */
export function resetFalClientForTests(): void {
  cached = null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Konuşmasız video (kâğıda yazı yazma gibi) HATA DEĞİL: boş metinli bir
 * transkript döner ve caption karelerden üretilir. Bu yüzden "boş sonuç"
 * burada asla throw edilmez — edilseydi o videolar hiç caption alamazdı.
 */
export async function transcribe(
  audioUrl: string,
  opts: { timeoutMs?: number } = {}
): Promise<Transcript> {
  const fal = falClient();
  try {
    const result = await fal.subscribe(WHISPER_MODEL, {
      input: { audio_url: audioUrl, task: "transcribe", chunk_level: "segment" },
      // Vercel fonksiyonu 60 sn'de kesiliyor; kesilirse post `generating`de
      // asılı kalır. Süre dolunca kendimiz vazgeçip `failed` yazabilelim diye.
      ...(opts.timeoutMs ? { abortSignal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    const chunks: TranscriptChunk[] = (result.data.chunks ?? [])
      .map((chunk) => {
        const ts = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
        return { text: (chunk.text ?? "").trim(), start: num(ts[0]), end: num(ts[1]) };
      })
      .filter((chunk) => chunk.text.length > 0);
    const text = (result.data.text ?? "").trim() || chunks.map((c) => c.text).join(" ");
    return { text, chunks };
  } catch (error) {
    if (error instanceof CaptionStepError) throw error;
    const status = error instanceof ApiError ? error.status : undefined;
    throw new CaptionStepError({
      step: "transcribe",
      retryable: isRetryableStatus(status),
      publicReason:
        status === undefined
          ? "Transkript servisine ulaşılamadı ya da zaman aşımına uğradı"
          : `Transkript servisi hata verdi (${status})`,
      detail: safeDetail(error),
    });
  }
}
