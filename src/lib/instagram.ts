/**
 * Instagram Graph API yayın katmanı.
 *
 * `furi/.claude/skills/insta-yayinla/scripts/ig_api.py` + `ig_yayinla.py`
 * akışının TypeScript karşılığı — orada canlıda doğrulanmış sıra korunur:
 *
 *   tek görsel : POST /{ig}/media → containerBekle → POST /{ig}/media_publish
 *   karusel    : her slayt için POST /{ig}/media (is_carousel_item)
 *                → hepsini bekle → CAROUSEL container → bekle → media_publish
 *
 * `containerBekle` atlanamaz: Instagram görseli kendisi çeker, çekmeden
 * `media_publish` çağrılırsa "Media ID is not available" hatası gelir.
 *
 * Instagram sınırları (hepsi doğrulanmış): yalnızca JPEG, public URL zorunlu,
 * en-boy 4:5 – 1.91:1, azami genişlik 1440px (fazlası kırpılmadan küçültülür),
 * 8MB dosya, karusel en fazla 10 görsel, 24 saatte 100 post kotası.
 */

const DEFAULT_HOST = "graph.instagram.com";
const DEFAULT_VERSION = "v23.0";

/** Karusel için Instagram'ın izin verdiği azami slayt sayısı. */
export const IG_MAX_CAROUSEL_ITEMS = 10;

/** Tek bir HTTP çağrısının azami süresi. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Container oluşturma + bekleme adımlarının toplam bütçesi. Vercel fonksiyon
 * süresi (maxDuration 60sn) aşılırsa süreç ortada kesilir ve `publishStatus`
 * "publishing"de takılı kalır; bütçe bunu önler.
 *
 * 40sn nereden: canlı ölçümde tek görsel uçtan uca 23.9sn, 6 slaytlık karusel
 * 34.2sn sürdü. Bütçe dolduktan sonra `media_publish` + permalink çağrıları
 * için ~15sn daha gerekebildiğinden, 60sn tavanına pay kalsın diye 40'ta tutulur.
 */
export const IG_DEFAULT_BUDGET_MS = 40_000;

/** Container hazır olma yoklaması: 2sn'den başlar, 10sn'ye kadar büyür. */
const POLL_START_MS = 2_000;
const POLL_MAX_MS = 10_000;

export class IGError extends Error {
  /** Meta'nın döndüğü ham JSON — `code`, `error_subcode`, `fbtrace_id` teşhis için gerekli. */
  readonly detail: Record<string, unknown>;
  readonly http?: number;

  constructor(message: string, detail: Record<string, unknown> = {}, http?: number) {
    super(message);
    this.name = "IGError";
    this.detail = detail;
    this.http = http;
  }

  /** Log ve `publishError` alanı için tek satırlık özet. */
  report(): string {
    const parts = [this.message];
    const error = this.detail.error;
    if (error && typeof error === "object") {
      const fields = error as Record<string, unknown>;
      for (const key of ["type", "code", "error_subcode", "error_user_msg", "fbtrace_id"]) {
        if (fields[key]) parts.push(`${key}=${String(fields[key])}`);
      }
    }
    return parts.join(" · ");
  }
}

function apiHost(): string {
  return process.env.IG_API_HOST || DEFAULT_HOST;
}

function apiBase(): string {
  const version = process.env.IG_API_VERSION || DEFAULT_VERSION;
  return `https://${apiHost()}/${version}`;
}

/**
 * Sürüm segmenti OLMAYAN kök. Token yenileme uç noktası (`refresh_access_token`)
 * Graph'ın sürümlü ağacında değil, host'un kökünde durur.
 */
function unversionedBase(): string {
  return `https://${apiHost()}`;
}

type Params = Record<string, string | undefined>;

async function call(
  path: string,
  params: Params,
  token: string,
  method: "GET" | "POST",
  base: string = apiBase()
): Promise<Record<string, unknown>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  search.set("access_token", token);

  const url = `${base}/${path.replace(/^\//, "")}`;
  const init: RequestInit = {
    method,
    headers: { "User-Agent": "content-approval-saas/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (method === "POST") {
    init.body = search;
  }

  let response: Response;
  try {
    response = await fetch(method === "GET" ? `${url}?${search}` : url, init);
  } catch (error) {
    throw new IGError(
      `Instagram API'ye ulaşılamadı (${method} ${path}): ${(error as Error).message}`
    );
  }

  const raw = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    if (!response.ok) {
      throw new IGError(
        `Instagram API HTTP ${response.status} döndü (${method} ${path})`,
        { raw_response: raw.slice(0, 200) },
        response.status
      );
    }
    throw new IGError(
      `Instagram API geçersiz JSON döndü (${method} ${path}): ${raw.slice(0, 200)}`
    );
  }

  if (!response.ok) {
    const error = body.error as { message?: string } | undefined;
    throw new IGError(
      error?.message || `Instagram API HTTP ${response.status} döndü (${method} ${path})`,
      body,
      response.status
    );
  }
  return body;
}

export type InstagramAccount = {
  /** IG professional account id — `Client.instagramUserId`'ye yazılan değer. */
  userId: string;
  /** @handle; yalnızca arayüzde "doğru hesap mı" teyidi için. */
  username: string | null;
};

/**
 * Token'ın hangi Instagram hesabına ait olduğunu sorar (GET /me?fields=user_id).
 *
 * Bağlama arayüzünde iki iş görür: token'ı Graph'a sorarak DOĞRULAR (geçersizse
 * IGError) ve `instagramUserId`'yi ajansın elle yazmasına gerek kalmadan doldurur.
 * Yayın akışının aksine bu çağrı ucuz ve tekildir — bütçe/bekleme gerekmez.
 */
export async function fetchInstagramAccount(accessToken: string): Promise<InstagramAccount> {
  const body = await call("me", { fields: "user_id,username" }, accessToken, "GET");
  // graph.instagram.com `user_id` döner; bazı sürümlerde alan `id` adıyla gelir.
  const userId = body.user_id ?? body.id;
  if (!userId) {
    throw new IGError("Instagram yanıtında hesap kimliği ('user_id') yok", body);
  }
  return {
    userId: String(userId),
    username: typeof body.username === "string" ? body.username : null,
  };
}

export type RefreshedInstagramToken = {
  /** Yeni long-lived token. Eskisi kısa süre daha geçerli kalır ama artık kullanılmaz. */
  accessToken: string;
  /** `expires_in` (saniye) şu ana eklenmiş hâli — doğrudan `instagramTokenExpiry`'ye yazılır. */
  expiresAt: Date;
};

/**
 * Long-lived token'ı 60 gün daha uzatır (GET /refresh_access_token).
 *
 * Instagram'ın iki şartı var: token HÂLÂ geçerli olmalı (süresi dolmuşsa
 * yenileme yolu kapanır, hesabın elle yeniden bağlanması gerekir) ve en az
 * 24 saat eski olmalı. İkincisini çağrı öncesi kontrol edemiyoruz — ihraç
 * tarihini saklamıyoruz — ama yenileme penceresi (bkz. `IG_TOKEN_REFRESH_DAYS`)
 * 60 günlük bir token'ın ömrünün sonuna denk geldiğinden pratikte hep sağlanır.
 *
 * Hata hâlinde her zaman `IGError` fırlatır; çağıran taraf (cron) tek tek
 * yakalayıp diğer müşterilere devam eder.
 */
export async function refreshInstagramToken(
  accessToken: string
): Promise<RefreshedInstagramToken> {
  const body = await call(
    "refresh_access_token",
    { grant_type: "ig_refresh_token" },
    accessToken,
    "GET",
    unversionedBase()
  );

  // Hata ayrıntısına ham token KOYULMAZ: `IGError.detail` log'a ve `publishError`
  // alanına düşebiliyor, yanıt gövdesi de `access_token` taşıyor.
  const safeDetail = { ...body, access_token: body.access_token ? "[gizlendi]" : undefined };

  const refreshed = body.access_token;
  if (typeof refreshed !== "string" || refreshed.trim() === "") {
    throw new IGError("Instagram yanıtında yeni token ('access_token') yok", safeDetail);
  }

  const expiresIn = Number(body.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new IGError(
      `Instagram yanıtındaki 'expires_in' geçersiz: ${String(body.expires_in)}`,
      safeDetail
    );
  }

  return { accessToken: refreshed, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

/** POST /{ig-user-id}/media → container id */
async function createContainer(
  igUserId: string,
  token: string,
  fields: Params
): Promise<string> {
  const body = await call(`${igUserId}/media`, fields, token, "POST");
  if (!body.id) {
    throw new IGError("Container oluşturuldu ama yanıtta 'id' yok", body);
  }
  return String(body.id);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Instagram görseli çekene kadar bekler. FINISHED değilse yayına geçilmez.
 * `deadline` (mutlak zaman damgası) aşılırsa bekleme kesilir — çağıran taraf
 * hatayı DB'ye yazacak zamanı bulur.
 */
async function waitForContainer(
  containerId: string,
  token: string,
  deadline: number
): Promise<void> {
  let last = "UNKNOWN";
  let wait = POLL_START_MS;

  while (Date.now() < deadline) {
    const body = await call(containerId, { fields: "status_code,status" }, token, "GET");
    last = String(body.status_code ?? "UNKNOWN");
    if (last === "FINISHED") return;
    if (last === "ERROR" || last === "EXPIRED") {
      throw new IGError(
        `Container ${containerId} durumu ${last}: ${String(body.status ?? "")}`,
        body
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(wait, remaining));
    wait = Math.min(wait * 1.5, POLL_MAX_MS);
  }

  throw new IGError(
    `Container ${containerId} ayrılan sürede hazır olmadı (son durum: ${last})`
  );
}

export type PublishInput = {
  igUserId: string;
  accessToken: string;
  imageUrls: string[];
  caption: string;
  altTexts?: (string | null | undefined)[];
  /** Toplam süre bütçesi (ms). Varsayılan {@link IG_DEFAULT_BUDGET_MS}. */
  budgetMs?: number;
};

export type PublishResult = { mediaId: string; permalink: string };

/**
 * Bir postu Instagram'a yayınlar. Başarısızlıkta her zaman `IGError` fırlatır;
 * çağıran taraf onay kaydına dokunmadan `publishStatus`'u "failed" yapar.
 */
export async function publishToInstagram(input: PublishInput): Promise<PublishResult> {
  const { igUserId, accessToken, imageUrls, caption } = input;

  if (imageUrls.length === 0) {
    throw new IGError("Yayınlanacak görsel yok");
  }
  if (imageUrls.length > IG_MAX_CAROUSEL_ITEMS) {
    throw new IGError(
      `Instagram karuseli en fazla ${IG_MAX_CAROUSEL_ITEMS} görsel kabul eder (${imageUrls.length} verildi)`
    );
  }

  const deadline = Date.now() + (input.budgetMs ?? IG_DEFAULT_BUDGET_MS);
  const altText = (index: number) => input.altTexts?.[index] ?? undefined;

  let containerId: string;

  if (imageUrls.length === 1) {
    containerId = await createContainer(igUserId, accessToken, {
      image_url: imageUrls[0],
      caption,
      alt_text: altText(0) ?? undefined,
    });
  } else {
    // Container oluşturma çağrısı Instagram görseli İNDİRDİĞİ için yavaştır —
    // ölçüldü: slayt başına ~8.5 sn. Sırayla yapılırsa 6 slayt tek başına ~52 sn
    // eder ve Vercel'in 60 sn tavanını aşar. Paralel oluşturulur; `Promise.all`
    // sonuç sırasını koruduğu için slayt sırası bozulmaz.
    const children = await Promise.all(
      imageUrls.map((url, index) =>
        createContainer(igUserId, accessToken, {
          image_url: url,
          is_carousel_item: "true",
          alt_text: altText(index) ?? undefined,
        })
      )
    );
    // Slaytlar birbirinden bağımsız indirilir — sırayla değil paralel beklenir.
    await Promise.all(children.map((child) => waitForContainer(child, accessToken, deadline)));

    containerId = await createContainer(igUserId, accessToken, {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption,
    });
  }

  await waitForContainer(containerId, accessToken, deadline);

  const published = await call(
    `${igUserId}/media_publish`,
    { creation_id: containerId },
    accessToken,
    "POST"
  );
  if (!published.id) {
    throw new IGError("Yayın çağrısı yanıtında 'id' yok", published);
  }
  const mediaId = String(published.id);

  // Permalink alınamazsa yayın yine de başarılı — sadece link boş kalır.
  let permalink = "";
  try {
    const info = await call(mediaId, { fields: "id,permalink" }, accessToken, "GET");
    permalink = typeof info.permalink === "string" ? info.permalink : "";
  } catch {
    permalink = "";
  }

  return { mediaId, permalink };
}
