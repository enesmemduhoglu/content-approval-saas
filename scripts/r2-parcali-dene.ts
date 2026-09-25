/**
 * V7b — R2 çok parçalı yüklemeyi GERÇEK bucket'a karşı bir kez dener.
 * Birim testleri R2'yi mock'luyor; imzalı `UploadPart` URL'inin R2'de
 * gerçekten kabul edildiği (SDK'nın varsayılan checksum parametreleri
 * imzayı bozuyor mu?), `ETag`'in döndüğü ve birleştirilmiş nesnenin boyutunun
 * doğru çıktığı yalnızca burada görülür.
 *
 * Çalıştırma (`@/` takma adları için vitest yapılandırması kullanılıyor):
 *
 *   npx vite-node --config vitest.config.ts scripts/r2-parcali-dene.ts
 *
 * Ne yapar: ~40 MB rastgele veriyi 8 MB parçalarla `clients/_dogrulama/`
 * altına yükler (3. parçayı bilerek iki kez gönderir — tekrar denemede son
 * gönderimin geçerli olduğunu görmek için), birleştirir, `headObject` ile
 * boyutu doğrular ve nesneyi siler. Sonra ikinci bir yükleme açıp bir parça
 * gönderir ve iptal eder (temizlik cron'unun yolu).
 *
 * Anahtarlar `.env.local`'den okunur, değerleri hiçbir koşulda yazdırılmaz.
 * DB'ye dokunmaz.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

function loadEnv(): void {
  const file = path.resolve(process.cwd(), ".env.local");
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(R2_[A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const PART_SIZE = 8 * 1024 * 1024;
const TOTAL = 40 * 1024 * 1024 + 123_457; // son parça kısa kalsın

async function putPart(url: string, body: Uint8Array): Promise<string> {
  const res = await fetch(url, { method: "PUT", body: new Uint8Array(body) });
  if (!res.ok) {
    // Gövde R2'nin XML hatası; sır taşımaz ama imza ayrıntısı içerebilir —
    // yalnızca kodu yazdır.
    const text = await res.text();
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "?";
    throw new Error(`parça PUT ${res.status} (${code})`);
  }
  const etag = res.headers.get("etag");
  if (!etag) throw new Error("ETag dönmedi");
  return etag;
}

async function main() {
  loadEnv();
  const r2 = await import("@/lib/storage-r2");
  if (!r2.r2Configured()) throw new Error("R2 env eksik");

  const stamp = Date.now();
  const key = `clients/_dogrulama/parcali-${stamp}.mp4`;
  const data = randomBytes(TOTAL);
  const count = Math.ceil(TOTAL / PART_SIZE);

  console.log(`1) çok parçalı yükleme: ${TOTAL} bayt, ${count} parça`);
  const uploadId = await r2.createMultipartUpload(key, "video/mp4");
  const parts: { partNumber: number; etag: string }[] = [];
  try {
    for (let n = 1; n <= count; n++) {
      const slice = data.subarray((n - 1) * PART_SIZE, Math.min(n * PART_SIZE, TOTAL));
      const url = await r2.signUploadPartUrl(key, uploadId, n);
      let etag = await putPart(url, slice);
      if (n === 3) {
        // Yarıda kalıp yeniden denenen parçanın taklidi: aynı numara ikinci kez.
        const again = await putPart(await r2.signUploadPartUrl(key, uploadId, n), slice);
        console.log(`   3. parça iki kez gönderildi, ETag aynı mı: ${again === etag}`);
        etag = again;
      }
      parts.push({ partNumber: n, etag });
      console.log(`   parça ${n}/${count} tamam (${slice.length} bayt)`);
    }
    await r2.completeMultipartUpload(key, uploadId, parts);
  } catch (error) {
    await r2.abortMultipartUpload(key, uploadId).catch(() => undefined);
    throw error;
  }

  const head = await r2.headObject(key);
  console.log(
    `   headObject: boyut=${head?.size} (beklenen ${TOTAL}) tip=${head?.contentType} → ${
      head?.size === TOTAL ? "DOĞRU" : "YANLIŞ"
    }`
  );

  console.log("   tamamlanmış yüklemeye ikinci complete (tekrar deneme taklidi):");
  try {
    await r2.completeMultipartUpload(key, uploadId, parts);
    console.log("   → hata yok (R2 idempotent)");
  } catch (error) {
    console.log(`   → ${r2.storageErrorCode(error)}`);
  }

  console.log("   yanlış ETag ile complete (yeni yükleme):");
  const badId = await r2.createMultipartUpload(`${key}.yanlis`, "video/mp4");
  try {
    const url = await r2.signUploadPartUrl(`${key}.yanlis`, badId, 1);
    await putPart(url, data.subarray(0, 1024));
    await r2.completeMultipartUpload(`${key}.yanlis`, badId, [
      { partNumber: 1, etag: '"00000000000000000000000000000000"' },
    ]);
    console.log("   → BEKLENMEDİK: kabul edildi");
  } catch (error) {
    console.log(`   → ${r2.storageErrorCode(error)}`);
  } finally {
    await r2.abortMultipartUpload(`${key}.yanlis`, badId);
  }

  console.log(`   silindi: ${await r2.deleteObject(key)}`);
  console.log(`   silindikten sonra headObject: ${JSON.stringify(await r2.headObject(key))}`);

  console.log("2) iptal yolu");
  const abortKey = `clients/_dogrulama/iptal-${stamp}.mp4`;
  const abortId = await r2.createMultipartUpload(abortKey, "video/mp4");
  await putPart(await r2.signUploadPartUrl(abortKey, abortId, 1), data.subarray(0, PART_SIZE));
  await r2.abortMultipartUpload(abortKey, abortId);
  console.log("   iptal edildi");
  try {
    await putPart(await r2.signUploadPartUrl(abortKey, abortId, 2), data.subarray(0, 1024));
    console.log("   → BEKLENMEDİK: iptalden sonra parça kabul edildi");
  } catch (error) {
    console.log(`   iptalden sonra parça PUT: ${(error as Error).message}`);
  }
  // İkinci iptal: `NoSuchUpload` sessizce yutulmalı (cron iki kez koşabilir).
  await r2.abortMultipartUpload(abortKey, abortId);
  console.log("   ikinci iptal hatasız (NoSuchUpload yutuldu)");
  console.log(`   nesne oluşmadı: ${JSON.stringify(await r2.headObject(abortKey))}`);
}

main().catch((error) => {
  console.error("HATA:", (error as Error).message);
  process.exit(1);
});
