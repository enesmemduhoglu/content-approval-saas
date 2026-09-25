import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Video kuyruğu (V1) — portal videoları ve kareleri için Cloudflare R2.
 *
 * Bucket GİZLİ; public erişim ve `r2.dev` adresi yok. Her erişim süreli imzalı
 * URL'le (K5): portal oynatıcısı, fal Whisper, Claude'a giden kareler ve
 * Instagram konteyneri aynı mekanizmayı kullanıyor. İmzalı URL YALNIZCA kapsam
 * doğrulandıktan sonra üretilmeli — anahtar düzeni bunu kolaylaştırmak için
 * `clients/<clientId>/...` önekli (bkz. `keyBelongsToClient`).
 *
 * Mevcut ajans/furi akışı Vercel Blob'da kalıyor (`blob.ts`); bu dosya ona
 * dokunmuyor.
 */

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Video depolama (R2) yapılandırılmamış");
  }
}

type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

function readConfig(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

/**
 * Env boşken sistem çalışmaya devam eder ama sessizce değil (CLAUDE.md deseni):
 * portal yüklemesi açık bir hatayla kapanır, çekirdek onay akışı etkilenmez.
 */
export function r2Configured(): boolean {
  return readConfig() !== null;
}

let cached: { client: S3Client; bucket: string } | null = null;

function r2(): { client: S3Client; bucket: string } {
  if (cached) return cached;
  const config = readConfig();
  if (!config) throw new StorageNotConfiguredError();
  cached = {
    bucket: config.bucket,
    client: new S3Client({
      // R2 S3 uyumlu; bölge kavramı yok, SDK yine de bir değer istiyor.
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }),
  };
  return cached;
}

/** Testlerin env değiştirdikten sonra istemciyi sıfırlayabilmesi için. */
export function resetStorageClientForTests(): void {
  cached = null;
}

// ─── Anahtar düzeni ──────────────────────────────────────────────────────

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function assertId(value: string, name: string): void {
  // Kimlikler cuid; `/` ya da `..` taşıyan bir değer başka müşterinin önekine
  // kaçabilirdi. Kaynağı her zaman DB olsa da anahtar üretimi ucuz bir yerde
  // ikinci kez korunuyor.
  if (!SAFE_ID.test(value)) throw new Error(`Geçersiz ${name}`);
}

export function videoKey(clientId: string, postId: string, ext: string): string {
  assertId(clientId, "clientId");
  assertId(postId, "postId");
  if (!/^[a-z0-9]{2,5}$/.test(ext)) throw new Error("Geçersiz uzantı");
  return `clients/${clientId}/videos/${postId}.${ext}`;
}

export function frameKey(clientId: string, postId: string, index: number): string {
  assertId(clientId, "clientId");
  assertId(postId, "postId");
  if (!Number.isInteger(index) || index < 0 || index > 99) throw new Error("Geçersiz kare");
  return `clients/${clientId}/frames/${postId}/${index}.jpg`;
}

/** İmzalı URL üretmeden önceki son kapı: anahtar bu müşterinin önekinde mi? */
export function keyBelongsToClient(key: string, clientId: string): boolean {
  return key.startsWith(`clients/${clientId}/`) && !key.includes("..");
}

// ─── İmzalı URL'ler ──────────────────────────────────────────────────────

/** Yükleme: tarayıcı doğrudan R2'ye PUT eder (Vercel'in 4.5 MB gövde sınırı yok). */
export const PUT_URL_TTL_SECONDS = 15 * 60;
/** Portal oynatıcı ve Claude kareleri için. */
export const GET_URL_TTL_SECONDS = 60 * 60;
/**
 * Instagram konteyneri ve fal için üst sınır. SigV4 imzası en fazla 7 gün
 * geçerli; Instagram videoyu konteyner kurulurken bir kez indiriyor.
 */
export const MAX_GET_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function signPutUrl(
  key: string,
  contentType: string,
  ttlSeconds: number = PUT_URL_TTL_SECONDS
): Promise<string> {
  const { client, bucket } = r2();
  // ContentType imzaya giriyor: tarayıcı başka bir tip beyan ederse R2 reddeder.
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: ttlSeconds }
  );
}

export async function signGetUrl(
  key: string,
  ttlSeconds: number = GET_URL_TTL_SECONDS
): Promise<string> {
  const { client, bucket } = r2();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: Math.min(ttlSeconds, MAX_GET_URL_TTL_SECONDS),
  });
}

export type ObjectInfo = { size: number; contentType: string | null };

/**
 * Yüklemenin gerçekten tamamlandığının kanıtı. İstemcinin "yükledim" demesine
 * güvenilmez: dosya yoksa ya da boyutu sınırı aşıyorsa post kuyruğa girmez.
 */
export async function headObject(key: string): Promise<ObjectInfo | null> {
  const { client, bucket } = r2();
  try {
    const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (status === 404) return null;
    throw error;
  }
}

/** Best-effort; silinemeyen nesne akışı düşürmez (post silme yolundaki Blob deseni). */
export async function deleteObject(key: string): Promise<boolean> {
  try {
    const { client, bucket } = r2();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    console.error(`[storage-r2] silinemedi: ${key}`, (error as Error).message);
    return false;
  }
}

// ─── Çok parçalı yükleme (V7b) ──────────────────────────────────────────

/**
 * iOS arka plana atılan sayfayı askıya alıyor; 150 MB'lık tek PUT yarıda
 * kalınca baştan başlıyordu. Çok parçalı yüklemede her parça ayrı bir imzalı
 * PUT: kopan parça tek başına yeniden denenir, bitmiş parçalar R2'de durur
 * (bkz. docs/video-kuyrugu/V7-pwa.md §5).
 *
 * `uploadId` yalnızca sunucuda (`Post.uploadId`) yaşar; bu fonksiyonlar onu
 * her zaman DB'den okunmuş hâliyle alır, istemcinin beyanıyla asla.
 */

/** Yeni çok parçalı yükleme açar ve R2'nin verdiği `uploadId`'yi döner. */
export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const { client, bucket } = r2();
  // Nesnenin tipi burada, açılışta sabitleniyor (parça PUT'larında tip yok);
  // `complete`'teki `headObject` tip kontrolü bu değeri görür.
  const out = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType })
  );
  if (!out.UploadId) throw new Error("R2 çok parçalı yükleme kimliği dönmedi");
  return out.UploadId;
}

/** Tek bir parça için imzalı PUT URL'i. Parça numarası S3 kuralıyla 1..10000. */
export async function signUploadPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  ttlSeconds: number = PUT_URL_TTL_SECONDS
): Promise<string> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new Error("Geçersiz parça numarası");
  }
  const { client, bucket } = r2();
  return getSignedUrl(
    client,
    new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: ttlSeconds }
  );
}

export type CompletedPart = { partNumber: number; etag: string };

/**
 * Parçaları tek nesnede birleştirir. Hata FIRLATIR — çağıran taraf
 * `storageErrorCode` ile ayırır: `InvalidPart` / `InvalidPartOrder` /
 * `EntityTooSmall` istemcinin yanlış listesi (400), `NoSuchUpload` yüklemenin
 * artık olmadığı (ör. önceki bir `complete` birleştirmiş ya da iptal edilmiş).
 */
export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: CompletedPart[]
): Promise<void> {
  const { client, bucket } = r2();
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        // S3 artan sıra ister; doğrulama zaten sıralıyor, burada yine de
        // garanti altına alınıyor ki çağıranın sırasına bağlı kalınmasın.
        Parts: [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
      },
    })
  );
}

/**
 * Yarıda kalan yüklemenin parçalarını siler. Tamamlanmamış parçalar R2'de yer
 * kaplar ama nesne olarak listelenmez — iptal edilmezse görünmez bir çöp olur.
 * Yükleme zaten yoksa (`NoSuchUpload`) iş yapılmış sayılır; diğer hatalar
 * fırlatılır ki temizlik taslağı silip kimliği kaybetmesin.
 */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  const { client, bucket } = r2();
  try {
    await client.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })
    );
  } catch (error) {
    if (storageErrorCode(error) === "NoSuchUpload") return;
    throw error;
  }
}

/**
 * SDK hatasının S3 kodu (`NoSuchUpload`, `InvalidPart`…). SDK v3 modellenmiş
 * hatalarda kodu `name`e, modellenmemişlerde `Code`a koyuyor; ikisine de bakılır.
 */
export function storageErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { Code, name } = error as { Code?: unknown; name?: unknown };
  if (typeof Code === "string") return Code;
  if (typeof name === "string") return name;
  return undefined;
}
