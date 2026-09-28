/**
 * r2-denetim.mjs
 * ------------------------------------------------------------------
 * NE YAPAR
 * R2 bucket'ının `clients/` önekini baştan sona listeler ve üç şey raporlar:
 *   1. Toplam kullanım (müşteri başına video / kare bayt ve adet) — 10 GB'lık
 *      ücretsiz katmanın neresindeyiz.
 *   2. YARIM çok parçalı yüklemeler: parçaları `ListObjectsV2`'de görünmez ama
 *      yer kaplar ve kotaya sayılır. 29 Eyl'de panel 2.14 GB derken nesne
 *      toplamı ~1.3 GB'tı. Toplam = nesneler + parçalar.
 *   3. SAHİPSİZ nesneler: DB'de karşılığı olmayan video ve kareler.
 *
 * Yarım yükleme şu durumda silinir (`--sil`): 24 saatten eski VE ya hiçbir
 * taslağın `uploadId`'si değil ya da taslağı 24 saatten eski (terk edilmiş —
 * gece taslak temizliği de alırdı). 24 saatten yeni taslağa bağlı olana
 * dokunulmaz: telefonda kaldığı yerden devam eden bir yükleme olabilir.
 *
 * Sahipsiz nesne nereden gelir (V9): R2 silmesi her yerde best-effort — DB
 * kaydı gider ya da anahtar düşürülür, R2 çağrısı başarısız olursa nesne
 * kalır ve yalnızca loglanır. Bu betik o artıkları yakalar.
 *
 * Sahipsiz sayılan:
 *   • video: hiçbir postun `videoKey`i değil,
 *   • kare: postu yok, ya da post taslak DEĞİL ve kare `frameKeys`te yok
 *     (yayından sonra arşivlenen videonun 1–5. kareleri). Taslağın kareleri
 *     `frameKeys`e yükleme bitince yazılır — taslaklarınkine dokunulmaz.
 *   • ve 24 saatten eski: şu an süren bir yüklemeyle yarışmasın.
 *
 * VARSAYILAN YALNIZCA RAPOR
 * `--sil` verilmedikçe tek bir yazma yapılmaz. `--sil` önce aynı raporu basar,
 * sonra sahipsiz nesneleri siler ve terk edilmiş yarım yüklemeleri iptal eder
 * (`AbortMultipartUpload`). DB'ye hiç yazmaz — iptal edilen taslağın satırını
 * gece taslak temizliği siler (`NoSuchUpload`'u "iş yapılmış" sayıyor).
 *
 * BAĞLANTI: `.env.local`'deki `POSTGRES_URL` (prod Neon) + `R2_*`. Host
 * `neon.tech` değilse sorgu açmadan çıkar (bkz. portal-video-temizligi.mjs).
 *
 * KULLANIM
 *   node scripts/r2-denetim.mjs          # rapor
 *   node scripts/r2-denetim.mjs --sil    # rapor + sahipsizleri SİLER
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIL = process.argv.slice(2).includes('--sil');
const YAS_SINIRI_MS = 24 * 60 * 60 * 1000;

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(KOK, '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
    })
);

const url = env.POSTGRES_URL;
if (!url) throw new Error('.env.local içinde POSTGRES_URL yok');
const host = new URL(url).hostname;
console.log(`Bağlantı: ${host}`);
if (!host.endsWith('neon.tech')) {
  console.error('Host prod (neon.tech) görünmüyor — çıkılıyor.');
  process.exit(1);
}
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
  if (!env[k]) throw new Error(`.env.local içinde ${k} yok`);
}

const db = new PrismaClient({ datasources: { db: { url } } });
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

/** `clients/<clientId>/videos/<postId>.<ext>` ya da `clients/<clientId>/frames/<postId>/<i>.jpg`. */
function parca(key) {
  const m = key.match(/^clients\/([^/]+)\/(videos|frames)\/([^/.]+)/);
  return m ? { clientId: m[1], tur: m[2], postId: m[3] } : null;
}

try {
  const nesneler = [];
  let token;
  do {
    const out = await r2.send(
      new ListObjectsV2Command({ Bucket: env.R2_BUCKET, Prefix: 'clients/', ContinuationToken: token })
    );
    for (const o of out.Contents ?? []) nesneler.push({ key: o.Key, size: o.Size ?? 0, at: o.LastModified });
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);

  const yarimlar = [];
  let keyMarker;
  let idMarker;
  do {
    const out = await r2.send(
      new ListMultipartUploadsCommand({
        Bucket: env.R2_BUCKET,
        Prefix: 'clients/',
        KeyMarker: keyMarker,
        UploadIdMarker: idMarker,
      })
    );
    for (const u of out.Uploads ?? []) {
      yarimlar.push({ key: u.Key, uploadId: u.UploadId, at: u.Initiated, size: 0, parts: 0 });
    }
    keyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
    idMarker = out.IsTruncated ? out.NextUploadIdMarker : undefined;
  } while (keyMarker);
  for (const y of yarimlar) {
    let partMarker;
    do {
      const out = await r2.send(
        new ListPartsCommand({
          Bucket: env.R2_BUCKET,
          Key: y.key,
          UploadId: y.uploadId,
          PartNumberMarker: partMarker,
        })
      );
      for (const p of out.Parts ?? []) {
        y.size += p.Size ?? 0;
        y.parts += 1;
      }
      partMarker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
    } while (partMarker);
  }

  const posts = await db.post.findMany({
    where: { source: 'portal' },
    select: { id: true, status: true, videoKey: true, frameKeys: true, uploadId: true, createdAt: true },
  });
  const postById = new Map(posts.map((p) => [p.id, p]));
  const videoKeys = new Set(posts.map((p) => p.videoKey).filter(Boolean));

  const ozet = new Map();
  const sahipsiz = [];
  const simdi = Date.now();
  for (const n of nesneler) {
    const p = parca(n.key);
    const musteri = p?.clientId ?? '(tanınmayan anahtar)';
    const s = ozet.get(musteri) ?? { videos: 0, videoB: 0, frames: 0, frameB: 0 };
    if (p?.tur === 'videos') {
      s.videos += 1;
      s.videoB += n.size;
    } else {
      s.frames += 1;
      s.frameB += n.size;
    }
    ozet.set(musteri, s);

    if (!p || simdi - n.at.getTime() < YAS_SINIRI_MS) continue;
    const post = postById.get(p.postId);
    const yetim =
      p.tur === 'videos'
        ? !videoKeys.has(n.key)
        : !post || (post.status !== 'draft' && !post.frameKeys.includes(n.key));
    if (yetim) sahipsiz.push(n);
  }

  const toplam = nesneler.reduce((t, n) => t + n.size, 0);
  const yarimB = yarimlar.reduce((t, y) => t + y.size, 0);
  console.log(
    `\nToplam: ${mb(toplam + yarimB)} (ücretsiz katman 10 GB) = ${nesneler.length} nesne ${mb(toplam)}` +
      ` + ${yarimlar.length} yarım yükleme ${mb(yarimB)}\n`
  );
  for (const [musteri, s] of ozet) {
    console.log(`  ${musteri}: ${s.videos} video ${mb(s.videoB)} · ${s.frames} kare ${mb(s.frameB)}`);
  }

  const postByUploadId = new Map(posts.filter((p) => p.uploadId).map((p) => [p.uploadId, p]));
  const terkedilmis = [];
  console.log(`\nYarım yüklemeler: ${yarimlar.length} · ${mb(yarimB)}`);
  for (const y of yarimlar) {
    const post = postByUploadId.get(y.uploadId);
    const eski = simdi - y.at.getTime() >= YAS_SINIRI_MS;
    const taslakEski = post && simdi - post.createdAt.getTime() >= YAS_SINIRI_MS;
    let durum;
    const bag = post ? `taslak ${post.id} (${post.status})` : 'hiçbir taslağa bağlı değil';
    if (!eski) durum = `${bag} · 24 saatten yeni — dokunulmaz`;
    else if (!post) durum = `SAHİPSİZ (${bag})`;
    else if (taslakEski) durum = `TERK EDİLMİŞ (${bag})`;
    else durum = `${bag} · taslak 24 saatten yeni — dokunulmaz`;
    if (eski && (!post || taslakEski)) terkedilmis.push(y);
    const saat = ((simdi - y.at.getTime()) / 3600000).toFixed(1);
    console.log(`  ${y.key} · ${y.parts} parça ${mb(y.size)} · ${saat} saat önce · ${durum}`);
  }

  const sahipsizB = sahipsiz.reduce((t, n) => t + n.size, 0);
  console.log(`\nSahipsiz (24 saatten eski): ${sahipsiz.length} nesne · ${mb(sahipsizB)}`);
  for (const n of sahipsiz.slice(0, 50)) console.log(`  ${n.key} · ${mb(n.size)}`);
  if (sahipsiz.length > 50) console.log(`  … ve ${sahipsiz.length - 50} tane daha`);

  if (!SIL) {
    console.log('\nYALNIZCA RAPOR: hiçbir şey silinmedi. Sahipsizleri silmek için --sil ekle.');
    process.exit(0);
  }
  let iptal = 0;
  for (const y of terkedilmis) {
    try {
      await r2.send(
        new AbortMultipartUploadCommand({ Bucket: env.R2_BUCKET, Key: y.key, UploadId: y.uploadId })
      );
      iptal += 1;
    } catch (e) {
      console.log(`  yarım yükleme iptal edilemedi: ${y.key} — ${e.name}`);
    }
  }
  console.log(`\nR2: ${iptal}/${terkedilmis.length} terk edilmiş yarım yükleme iptal edildi.`);
  let hatali = 0;
  for (let i = 0; i < sahipsiz.length; i += 1000) {
    const dilim = sahipsiz.slice(i, i + 1000);
    const out = await r2.send(
      new DeleteObjectsCommand({
        Bucket: env.R2_BUCKET,
        Delete: { Objects: dilim.map((n) => ({ Key: n.key })), Quiet: true },
      })
    );
    hatali += out.Errors?.length ?? 0;
    for (const e of out.Errors ?? []) console.log(`  R2 silinemedi: ${e.Key} — ${e.Code}`);
  }
  console.log(`\nR2: ${sahipsiz.length - hatali}/${sahipsiz.length} sahipsiz nesne silindi.`);
} finally {
  await db.$disconnect();
}
