/**
 * kapak-onar.mjs
 * ------------------------------------------------------------------
 * NE YAPAR
 * Portaldan yüklenmiş ama karesi (kapak + caption bağlamı) olmayan videoların
 * 6 karesini SONRADAN üretir. Canlıda (2026-09-28) 19 tamamlanmış portal
 * videosunun yalnızca 4'ünde kare vardı: tarayıcıdaki çıkarma (iPhone PWA)
 * sessizce boş dönüyordu. İstemci tarafı düzeltmesi yeni yüklemeler için;
 * bu betik eskiler için.
 *
 * Kareler tarayıcıdakiyle AYNI kuralla alınır (frames-client.ts): 6 eşit
 * aralığın ORTASINDAN, genişlik ≤ 720 px, JPEG. Anahtar düzeni storage-r2.ts
 * `frameKey` ile aynı: clients/<clientId>/frames/<postId>/<i>.jpg.
 *
 * Kapsam: seçilen müşterinin `source = 'portal'`, `status != 'draft'`,
 * `frameKeys` boş, `videoKey` dolu postları. Caption'a DOKUNMAZ (zaten
 * üretilmiş); yalnızca kareler ve `frameKeys` yazılır.
 *
 * VARSAYILAN DRY-RUN
 * Bayrak verilmedikçe hiçbir yazma yapılmaz; yalnızca liste basılır.
 *   --dry-run-extract=<postId>  O postun videosunu indirip kareleri YALNIZCA
 *                               yerelde çıkarır (R2'ye ve DB'ye yazmaz);
 *                               kareler `--keep` verilirse silinmez.
 *   --apply                     Listelenen her post için indir → çıkar →
 *                               R2'ye PUT → `frameKeys` koşullu güncelle
 *                               (yalnızca hâlâ boşsa: arada yeni bir yükleme
 *                               ya da başka bir onarım yazdıysa ezilmez).
 *   --only=<postId>             Listeyi tek posta daralt.
 *
 * GEREKSİNİM: PATH'te `ffmpeg` ve `ffprobe`.
 *
 * BAĞLANTI: `.env.local`'deki `POSTGRES_URL` (prod Neon) ve `R2_*`.
 * `DATABASE_URL` yereli gösterir — bkz. prod-test-verisi-temizligi.mjs'teki
 * tuzak notu. Host `neon.tech` değilse betik sorgu açmadan çıkar.
 *
 * KULLANIM
 *   node scripts/kapak-onar.mjs                                   # dry-run, "Furkan Teacher"
 *   node scripts/kapak-onar.mjs --dry-run-extract=<postId> --keep # tek videoyu yerelde dene
 *   node scripts/kapak-onar.mjs --apply                           # GERÇEKTEN YAZAR (R2 + DB)
 *   node scripts/kapak-onar.mjs --client="Başka Müşteri"
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const FRAME_COUNT = 6; // portal-validation.ts / frames-client.ts ile aynı
const FRAME_MAX_WIDTH = 720;
const MAX_FRAME_BYTES = 2 * 1024 * 1024; // complete route'u bundan büyüğünü kare saymıyor

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const bayrak = (ad) => argv.find((a) => a.startsWith(`--${ad}=`))?.slice(ad.length + 3);
const APPLY = argv.includes('--apply');
const KEEP = argv.includes('--keep');
const DENE = bayrak('dry-run-extract');
const ONLY = bayrak('only');
const MUSTERI = bayrak('client') ?? 'Furkan Teacher';

if (APPLY && DENE) {
  console.error('--apply ile --dry-run-extract birlikte kullanılamaz.');
  process.exit(1);
}

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

/** storage-r2.ts `frameKey` ile aynı düzen. */
const frameKey = (clientId, postId, i) => `clients/${clientId}/frames/${postId}/${i}.jpg`;

async function indir(key, hedef) {
  const out = await r2.send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  await pipeline(out.Body, fs.createWriteStream(hedef));
}

function sure(dosya) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', dosya],
    { encoding: 'utf8' }
  );
  const d = Number(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`süre okunamadı (${out.trim()})`);
  return d;
}

/**
 * Tarayıcıdaki kuralla 6 kare. `-ss` girdiden ÖNCE: hızlı arama (anahtar kareye
 * atlar, sonra doğru kareye kadar çözer — ffmpeg 2.1'den beri kare-doğru).
 * ffmpeg iPhone .mov'undaki döndürme bilgisini varsayılan olarak uygular,
 * yani dikey video dikey çıkar; ölçek döndürmeden SONRA uygulanır.
 * `-q:v 3`: tarayıcının `toBlob(..., 0.8)`'ine yakın (720 px karede ~20–30 KB).
 */
function kareleriCikar(video, klasor, d) {
  const dosyalar = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const t = (d * (i + 0.5)) / FRAME_COUNT;
    const cikti = path.join(klasor, `${i}.jpg`);
    execFileSync(
      'ffmpeg',
      [
        '-v', 'error', '-y',
        '-ss', t.toFixed(3),
        '-i', video,
        '-frames:v', '1',
        '-vf', `scale='min(${FRAME_MAX_WIDTH},iw)':-2`,
        '-q:v', '3',
        cikti,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    const boyut = fs.statSync(cikti).size;
    if (boyut <= 0 || boyut > MAX_FRAME_BYTES) throw new Error(`${i}. kare boyutu sınır dışı (${boyut} bayt)`);
    dosyalar.push({ dosya: cikti, boyut, t });
  }
  return dosyalar;
}

function kareBoyutu(dosya) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', dosya],
    { encoding: 'utf8' }
  );
  return out.trim().replace(',', 'x');
}

/** Bir postu indirip kareleri çıkarır; `yukle` true ise R2'ye ve DB'ye yazar. */
async function onar(client, post, { yukle, sakla }) {
  const klasor = fs.mkdtempSync(path.join(os.tmpdir(), `kapak-${post.id}-`));
  try {
    const ext = path.extname(post.videoKey) || '.mp4';
    const video = path.join(klasor, `video${ext}`);
    await indir(post.videoKey, video);
    const d = sure(video);
    const kareler = kareleriCikar(video, klasor, d);
    console.log(
      `  ${post.id}: ${(fs.statSync(video).size / 1048576).toFixed(1)} MB, ${d.toFixed(1)} sn → ` +
        kareler.map((k) => `${Math.round(k.boyut / 1024)}k@${k.t.toFixed(1)}s`).join(' ') +
        ` (${kareBoyutu(kareler[0].dosya)})`
    );
    if (!yukle) {
      if (sakla) console.log(`  Kareler: ${klasor}`);
      return 'denendi';
    }

    const keys = kareler.map((_, i) => frameKey(client.id, post.id, i));
    await Promise.all(
      kareler.map((k, i) =>
        r2.send(
          new PutObjectCommand({
            Bucket: env.R2_BUCKET,
            Key: keys[i],
            Body: fs.readFileSync(k.dosya),
            ContentType: 'image/jpeg',
          })
        )
      )
    );
    // Koşullu yazma (CLAUDE.md yarış kuralı): yalnızca hâlâ boşsa.
    const r = await db.post.updateMany({
      where: { id: post.id, clientId: client.id, source: 'portal', frameKeys: { isEmpty: true } },
      data: { frameKeys: keys },
    });
    return r.count === 1 ? 'onarıldı' : 'atlandı (frameKeys artık dolu)';
  } finally {
    if (!(sakla && !yukle)) fs.rmSync(klasor, { recursive: true, force: true });
  }
}

try {
  const clients = await db.client.findMany({ where: { name: MUSTERI }, select: { id: true, name: true } });
  if (clients.length !== 1) {
    console.error(`"${MUSTERI}" adlı tam 1 müşteri bekleniyordu, ${clients.length} bulundu.`);
    process.exit(1);
  }
  const client = clients[0];

  if (DENE) {
    // Listede olmasa da (ör. zaten kareli bir post) yerel deneme serbest: yazma yok.
    const post = await db.post.findFirst({
      where: { id: DENE, clientId: client.id, source: 'portal' },
      select: { id: true, videoKey: true },
    });
    if (!post?.videoKey) {
      console.error(`${DENE}: bu müşterinin videolu portal postu değil.`);
      process.exit(1);
    }
    console.log(`\nYerel deneme (R2'ye ve DB'ye YAZILMAZ):`);
    await onar(client, post, { yukle: false, sakla: KEEP });
    process.exit(0);
  }

  const posts = await db.post.findMany({
    where: {
      clientId: client.id,
      source: 'portal',
      status: { not: 'draft' },
      frameKeys: { isEmpty: true },
      videoKey: { not: null },
      ...(ONLY ? { id: ONLY } : {}),
    },
    select: { id: true, videoKey: true, status: true, publishStatus: true, createdAt: true, caption: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\nMüşteri: ${client.name} (${client.id}) — karesiz ${posts.length} portal videosu\n`);
  for (const p of posts) {
    const cap = p.caption.replace(/\s+/g, ' ').slice(0, 50);
    console.log(`  ${p.id} · ${p.createdAt.toISOString().slice(0, 16)} · ${p.status}/${p.publishStatus} · "${cap}"`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN: hiçbir şey yazılmadı. Onarmak için --apply ekle.');
    process.exit(0);
  }

  console.log('');
  const sonuc = {};
  for (const p of posts) {
    try {
      const s = await onar(client, p, { yukle: true, sakla: false });
      sonuc[s] = (sonuc[s] ?? 0) + 1;
      console.log(`  → ${s}`);
    } catch (e) {
      // Bir videonun patlaması diğerlerini durdurmasın; yeniden koşmak güvenli
      // (koşullu yazma, R2 PUT'u aynı anahtarın üzerine yazar).
      sonuc.hata = (sonuc.hata ?? 0) + 1;
      console.log(`  ${p.id}: HATA — ${e.message}`);
    }
  }
  console.log(`\nSonuç: ${JSON.stringify(sonuc)}`);
} finally {
  await db.$disconnect();
}
