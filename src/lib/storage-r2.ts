import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
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
