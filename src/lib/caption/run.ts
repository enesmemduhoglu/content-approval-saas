import { sendAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { notifyCaptionsReady } from "@/lib/push";
import { keyBelongsToClient, signGetUrl, StorageNotConfiguredError } from "@/lib/storage-r2";
import { CaptionStepError, InvalidModelOutputError, safeDetail } from "./errors";
import { generateCaption } from "./generate";
import { transcribe } from "./transcribe";
import { validateDraft } from "./validate";

/**
 * Video kuyruğu (V2) — tek bir portal postu için caption üretiminin
 * orkestrasyonu: kilit → transkript → üretim → doğrulama → sonuç.
 *
 * ─── Sözleşme: ASLA throw etmez ─────────────────────────────────────────────
 * Çağıran QStash uç noktası; bir istisna 500'e dönüşür ve post `generating`de
 * asılı kalırdı. Her dış hata `failed` + kısa Türkçe `captionError` olarak
 * yazılır, operatöre `sendAlert` gider. Dönüşteki `retryable` uç noktanın
 * 5xx mi 200 mü döneceğini belirler: geçici hatada QStash tüm işi yeniden
 * dener ve kilit `failed` postu yeniden alır — ayrı bir "tekrar dene" yolu
 * gerekmiyor.
 *
 * ─── Neden bir zaman bütçesi var ───────────────────────────────────────────
 * Vercel fonksiyonu 60 sn'de KESİLİR; kesilen çağrı `failed` yazamaz ve post
 * `generating`de kalır. O yüzden adımlar ortak bir bütçeden süre alır ve
 * bütçe biterse kendimiz vazgeçip `failed` yazarız. Kesilme yine de olursa
 * (soğuk başlangıç, yavaş DB) `STALE_AFTER_MS` sonra post yeniden alınabilir.
 */

/** 60 sn tavanın altında: `failed` yazacak ve yanıt dönecek pay kalsın. */
const TIME_BUDGET_MS = 50_000;
/**
 * Elle denemede (2026-09-25) 33 sn'lik video için Whisper sıcakken ~12 sn,
 * soğuk başlangıçta 65 sn sürdü. 30 sn'de vazgeçip `failed` (tekrar
 * denenebilir) yazıyoruz; QStash'in tekrarı genellikle ısınmış servise düşer.
 * Üretime ~20 sn kalır — tek Claude çağrısı ~11 sn ölçüldü.
 */
const TRANSCRIBE_MAX_MS = 30_000;
/** İkinci üretim denemesine bundan az süre kaldıysa denemek boşa para. */
const MIN_GENERATE_MS = 12_000;
/**
 * Bu süredir `generating`de duran post takılmış sayılır. Ayrı bir "kilit
 * zamanı" kolonu yok (şema bu fazın dışında); `updatedAt` kullanılıyor. Kuyruk
 * sırası değişince o da güncellendiği için devralma yalnızca GECİKEBİLİR,
 * erkene çekilemez — güvenli taraf.
 */
export const STALE_AFTER_MS = 10 * 60_000;
/** Notun prompt'u şişirmemesi için; portal zaten kısa not alıyor. */
const MAX_NOTE_LENGTH = 500;
/** Doğrulamadan geçmeyen çıktı bir kez yeniden üretilir (README §3.4). */
const MAX_ATTEMPTS = 2;

export type CaptionSkipReason =
  | "not_found"
  | "not_portal"
  | "busy"
  | "already_ready"
  | "not_pending";

export type CaptionRunOutcome =
  | { status: "ready"; caption: string; altText: string }
  | { status: "failed"; reason: string; retryable: boolean }
  | { status: "skipped"; reason: CaptionSkipReason };

export async function runCaption(
  postId: string,
  opts: { note?: string } = {}
): Promise<CaptionRunOutcome> {
  const startedAt = Date.now();
  const remaining = () => TIME_BUDGET_MS - (Date.now() - startedAt);

  // ─── Kilit ─────────────────────────────────────────────────────────────
  // Koşullu UPDATE (CLAUDE.md "Yarış koruması"): QStash aynı mesajı iki kez
  // teslim edebilir, kullanıcı "yeniden üret"e iki kez basabilir. Yalnızca
  // satırı `generating`e çeviren çağrı üretir; diğeri hiçbir dış servise
  // dokunmadan çıkar. `ready` bilerek listede yok: tamamlanmış işin QStash
  // tekrarı caption'ı (belki elle düzenlenmişini) ezmesin. Yeniden üretmede
  // portal önce durumu `pending`e çeker.
  let locked: number;
  try {
    const res = await db.post.updateMany({
      where: {
        id: postId,
        source: "portal",
        OR: [
          { captionStatus: { in: ["pending", "failed"] } },
          {
            captionStatus: "generating",
            updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
          },
        ],
      },
      data: { captionStatus: "generating", captionError: null },
    });
    locked = res.count;
  } catch (error) {
    // DB'ye ulaşılamıyorsa `failed` da yazılamaz; tek yapılabilecek QStash'in
    // tekrar denemesine bırakmak.
    await alert("caption:db", "Caption kilidi alınamadı (DB)", postId, safeDetail(error), true);
    return { status: "failed", reason: "Veritabanına ulaşılamadı", retryable: true };
  }

  if (locked === 0) return { status: "skipped", reason: await skipReason(postId) };

  try {
    const post = await db.post.findUniqueOrThrow({
      where: { id: postId },
      select: {
        clientId: true,
        caption: true,
        videoKey: true,
        frameKeys: true,
        transcript: true,
        client: { select: { captionStyle: true } },
      },
    });

    // İmzalı URL yalnızca kapsam doğrulandıktan sonra (storage-r2.ts). Anahtar
    // DB'den geliyor ama başka müşterinin önekine işaret eden bir değer, o
    // müşterinin videosunu fal'a/Claude'a sızdırmak demek olurdu.
    if (!post.videoKey || !keyBelongsToClient(post.videoKey, post.clientId)) {
      return await fail(postId, "Video dosyası bulunamadı", false);
    }
    const frameKeys = post.frameKeys.filter((key) => keyBelongsToClient(key, post.clientId));

    // ─── Transkript ──────────────────────────────────────────────────────
    // `null` = hiç alınmadı; "" = alındı, videoda konuşma yok. İkincisi de
    // kalıcı bir sonuç — yeniden üretmede Whisper tekrar çağrılmaz.
    let transcript = post.transcript;
    if (transcript === null) {
      const audioUrl = await sign(post.videoKey);
      const result = await transcribe(audioUrl, {
        timeoutMs: Math.max(1_000, Math.min(TRANSCRIBE_MAX_MS, remaining() - MIN_GENERATE_MS)),
      });
      transcript = result.text;
      // Hemen yazılır: üretim patlarsa QStash'in tekrarı Whisper'ı yeniden
      // ödemesin, bütçenin tamamı Claude'a kalsın.
      await db.post.update({ where: { id: postId }, data: { transcript } });
    }

    const frameUrls = await Promise.all(frameKeys.map((key) => sign(key)));
    const note = opts.note?.trim().slice(0, MAX_NOTE_LENGTH) || undefined;
    const currentCaption = post.caption.trim() || undefined;

    // ─── Üretim + doğrulama ──────────────────────────────────────────────
    let problems: string[] | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (remaining() < MIN_GENERATE_MS) {
        // Transkript kayıtlı; QStash'in tekrarı doğrudan üretimden başlar.
        return await fail(postId, "Caption üretimi zaman aşımına uğradı", true);
      }
      let raw: unknown;
      try {
        raw = await generateCaption({
          frameUrls,
          transcript,
          captionStyle: post.client.captionStyle,
          note,
          currentCaption,
          previousProblems: problems,
          timeoutMs: remaining() - 2_000,
        });
      } catch (error) {
        if (!(error instanceof InvalidModelOutputError)) throw error;
        problems = [error.message];
        continue;
      }
      const checked = validateDraft(raw);
      if (!checked.ok) {
        problems = checked.problems;
        continue;
      }
      // Koşullu yazım: bu arada takılı sayılıp başka bir çağrıya devredildiysek
      // ve o çağrı çoktan bitirdiyse onun sonucunu ezmeyelim.
      const written = await db.post.updateMany({
        where: { id: postId, captionStatus: "generating" },
        data: { captionStatus: "ready", caption: checked.caption, captionError: null },
      });
      // V7c: "onayına hazır" bildirimi — toplu ve kısmalı (`push.ts`); throw
      // etmez. Yazım BU çağrıda olduysa: devredilmiş eski çağrının geç
      // gelen sonucu ikinci bir bildirim tetiklemesin.
      if (written.count === 1) await notifyCaptionsReady(post.clientId);
      // altText şimdilik SAKLANMIYOR: şemada portal postu için alan yok
      // (`PostImage.altText` görsel satırına ait, Reels'te satır yok). Dönüşte
      // tutuluyor ki şema kararı verildiğinde tek satırla yazılsın.
      return { status: "ready", caption: checked.caption, altText: checked.draft.altText };
    }

    // Kurallara uymayan çıktı içerik sorunu, dış hata değil: tekrar denemek
    // büyük ihtimalle aynı sonucu verir, uyarı da gerekmez — portalda
    // "yeniden üret" (belki bir notla) kullanıcının elinde.
    const summary = (problems ?? []).slice(0, 2).join("; ");
    return await fail(postId, `Caption kurallara uygun üretilemedi: ${summary}`.slice(0, 300), false);
  } catch (error) {
    if (error instanceof CaptionStepError) {
      await alert(
        `caption:${error.step}`,
        `Caption üretimi başarısız (${error.step})`,
        postId,
        error.detail ?? error.publicReason,
        error.retryable
      );
      return await fail(postId, error.publicReason, error.retryable);
    }
    await alert("caption:unexpected", "Caption üretiminde beklenmeyen hata", postId, safeDetail(error), true);
    return await fail(postId, "Beklenmeyen bir hata oluştu", true);
  }
}

async function sign(key: string): Promise<string> {
  try {
    return await signGetUrl(key);
  } catch (error) {
    throw new CaptionStepError({
      step: error instanceof StorageNotConfiguredError ? "config" : "storage",
      retryable: !(error instanceof StorageNotConfiguredError),
      publicReason: "Video depolamasına erişilemedi",
      detail: safeDetail(error),
    });
  }
}

/**
 * `failed` yazar. Kendisi de patlayabilir (DB gitmiş olabilir); o durumda
 * post `generating`de kalır ve `STALE_AFTER_MS` sonra yeniden alınabilir.
 */
async function fail(postId: string, reason: string, retryable: boolean): Promise<CaptionRunOutcome> {
  try {
    await db.post.updateMany({
      where: { id: postId, captionStatus: "generating" },
      data: { captionStatus: "failed", captionError: reason },
    });
  } catch (error) {
    console.error(`[caption] ${postId} failed yazılamadı:`, safeDetail(error));
  }
  return { status: "failed", reason, retryable };
}

async function skipReason(postId: string): Promise<CaptionSkipReason> {
  try {
    const post = await db.post.findUnique({
      where: { id: postId },
      select: { source: true, captionStatus: true },
    });
    if (!post) return "not_found";
    if (post.source !== "portal") return "not_portal";
    if (post.captionStatus === "generating") return "busy";
    if (post.captionStatus === "ready") return "already_ready";
    return "not_pending";
  } catch {
    // Neden bilinmiyor ama iş alınmadı; "meşgul" en zararsız cevap.
    return "busy";
  }
}

async function alert(
  key: string,
  title: string,
  postId: string,
  detail: string,
  retryable: boolean
): Promise<void> {
  await sendAlert(key, title, { postId, detail, retryable });
}
