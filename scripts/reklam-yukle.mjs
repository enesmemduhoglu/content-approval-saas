/**
 * reklam-yukle.mjs
 * ------------------------------------------------------------------
 * NE YAPAR
 * Yerel klasörlerdeki reklam görsellerini (V12, K36) bir müşterinin reklam
 * havuzuna, VERİLEN SIRAYLA yükler. Portaldaki yükleyicinin yaptığının
 * aynısı, sunucu tarafında:
 *   taslak `Post` (isAd, status draft) → R2 PUT → HEAD doğrulaması → `pending`.
 * Portal üzerinden yüklemek müşterinin oturumunu (e-postasına giden kod)
 * gerektiriyor; bu betik ajansın elindeki görselleri toplu koymak için.
 *
 * Sıra: havuz `adPosition` ile sıralanır (`ads.ts > compareAds`, V12c). Her
 * dosya havuzun SONUNA, verilen sırayla 1024'lük adımlarla konum alır
 * (`client-scoped-db > ads.createDrafts` ile aynı kural); satırlar tek tek
 * yazıldığı için `createdAt` da artan. `sourceName` "seri/01.jpg" biçiminde:
 * iki klasörde aynı adlı dosya ("1.jpg" / "01.jpg") portalda ayırt edilsin.
 *
 * Doğrulamalar portal yolundakiyle aynı (portal-validation.ts, jpeg-size.ts):
 * JPEG, ≤ 8 MB, oran 4:5…1.91:1. Uymayan dosya varsa HİÇBİR şey yüklenmez.
 *
 * TEKRAR KOŞULABİLİR: aynı `sourceName`le taslak olmayan reklamı zaten olan
 * dosya atlanır. Yarıda kalan dosya `draft` kalır; günlük `draft-cleanup`
 * 24 saatte satırı ve nesneyi temizler, betik yeniden koşunca yeniden yükler.
 *
 * Reklam AYARINA dokunmaz: havuz dolar, reklam portaldan açılana kadar
 * yayın olmaz.
 *
 * VARSAYILAN DRY-RUN — `--apply` verilmedikçe hiçbir yazma yapılmaz.
 *
 * BAĞLANTI: `.env.local`'deki `POSTGRES_URL` (prod Neon) ve `R2_*`.
 * `DATABASE_URL` yereli gösterir; host `neon.tech` değilse betik çıkar.
 * Müşteri: `--client-id=<id>`, verilmezse `../furi1/.env` → `FURI_CLIENT_ID`.
 *
 * KULLANIM
 *   node scripts/reklam-yukle.mjs <klasör|dosya> [<klasör|dosya> ...]           # dry-run
 *   node scripts/reklam-yukle.mjs <...> --apply                                 # GERÇEKTEN YÜKLER
 * Klasör verilirse içindeki YALNIZCA rakamla başlayan .jpg'ler alınır
 * ("01.jpg", "8b.jpg"; "_onizleme-1.jpg" alınmaz), sayısal sırayla.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const bayrak = (ad) => argv.find((a) => a.startsWith(`--${ad}=`))?.slice(ad.length + 3);
const kaynaklar = argv.filter((a) => !a.startsWith('--'));

const MAX_AD_BYTES = 8 * 1024 * 1024; // portal-validation.ts
const MIN_RATIO = 0.8;
const MAX_RATIO = 1.91;

function envOku(dosya) {
  if (!fs.existsSync(dosya)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(dosya, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
      })
  );
}

/** jpeg-size.ts'in eşi (betik TS import edemiyor). */
function jpegBoyutu(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) m = b[++i + 1];
    i += 2;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9 || m === 0xda) return null;
    const len = (b[i] << 8) | b[i + 1];
    if (SOF.has(m)) return { en: (b[i + 5] << 8) | b[i + 6], boy: (b[i + 3] << 8) | b[i + 4] };
    i += len;
  }
  return null;
}

const sayisal = new Intl.Collator('tr', { numeric: true });

/** Kaynak listesi → sıralı dosyalar. Klasörün içi sayısal sırayla, kaynaklar verildiği sırayla. */
function dosyalar() {
  const out = [];
  for (const kaynak of kaynaklar) {
    const tam = path.resolve(kaynak);
    if (!fs.existsSync(tam)) throw new Error(`Bulunamadı: ${kaynak}`);
    if (fs.statSync(tam).isDirectory()) {
      const adlar = fs
        .readdirSync(tam)
        .filter((ad) => /^\d+[a-z]?\.jpe?g$/i.test(ad))
        .sort(sayisal.compare);
      for (const ad of adlar) out.push({ yol: path.join(tam, ad), ad: `${path.basename(tam)}/${ad}` });
    } else {
      out.push({ yol: tam, ad: `${path.basename(path.dirname(tam))}/${path.basename(tam)}` });
    }
  }
  return out;
}

if (kaynaklar.length === 0) {
  console.error('Kullanım: node scripts/reklam-yukle.mjs <klasör|dosya> ... [--apply]');
  process.exit(1);
}

// ─── 1. Dosyalar: hepsi geçmeden hiçbir şey yüklenmez ─────────────────────

const liste = dosyalar().map((d) => {
  const bayt = fs.readFileSync(d.yol);
  const boyut = jpegBoyutu(bayt);
  let sorun = null;
  if (!boyut) sorun = 'JPEG değil';
  else if (bayt.length > MAX_AD_BYTES) sorun = '8 MB üstü';
  else {
    const oran = boyut.en / boyut.boy;
    if (oran < MIN_RATIO - 0.001 || oran > MAX_RATIO + 0.001) sorun = `oran ${oran.toFixed(3)}`;
  }
  return { ...d, bayt, boyut, sorun };
});
const bozuk = liste.filter((d) => d.sorun);
const toplamKB = liste.reduce((t, d) => t + d.bayt.length, 0) / 1024;
console.log(`${liste.length} görsel · ${(toplamKB / 1024).toFixed(1)} MB`);
if (bozuk.length > 0) {
  for (const d of bozuk) console.error(`  ✗ ${d.ad}: ${d.sorun}`);
  console.error('Uygun olmayan dosya var — hiçbir şey yüklenmedi.');
  process.exit(1);
}

// ─── 2. Bağlantı ───────────────────────────────────────────────────────────

const env = envOku(path.join(KOK, '.env.local'));
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
const clientId = bayrak('client-id') ?? envOku(path.join(KOK, '..', 'furi1', '.env')).FURI_CLIENT_ID;
if (!clientId || !/^[A-Za-z0-9_-]+$/.test(clientId)) throw new Error('Müşteri kimliği yok/geçersiz (--client-id)');

const db = new PrismaClient({ datasources: { db: { url } } });
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});

try {
  const client = await db.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, agencyId: true, publishSettings: { select: { adsEnabled: true } } },
  });
  if (!client) throw new Error(`Müşteri bulunamadı: ${clientId}`);
  console.log(`Müşteri: ${client.name} (${client.id}) · reklam ${client.publishSettings?.adsEnabled ? 'AÇIK' : 'kapalı'}`);

  const mevcut = await db.post.findMany({
    where: { clientId, source: 'portal', isAd: true, status: { not: 'draft' } },
    select: { sourceName: true },
  });
  const var_ = new Set(mevcut.map((p) => p.sourceName));
  const yuklenecek = liste.filter((d) => !var_.has(d.ad));
  console.log(`Havuzda zaten: ${mevcut.length} reklam · atlanacak: ${liste.length - yuklenecek.length} · yüklenecek: ${yuklenecek.length}`);
  yuklenecek.forEach((d, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${d.ad} · ${d.boyut.en}×${d.boyut.boy} · ${(d.bayt.length / 1024).toFixed(0)} KB`)
  );

  if (!APPLY) {
    console.log('\nDRY-RUN — hiçbir şey yazılmadı. Yüklemek için: --apply');
  } else {
    let tamam = 0;
    const agg = await db.post.aggregate({
      where: { clientId, source: 'portal', isAd: true },
      _max: { adPosition: true },
    });
    let konum = agg._max.adPosition ?? 0;
    for (const d of yuklenecek) {
      konum += 1024; // queue.ts > POSITION_STEP
      // Satır önce: anahtar post id'sinden türüyor (storage-r2.ts > adImageKey).
      const post = await db.post.create({
        data: {
          agencyId: client.agencyId,
          clientId,
          source: 'portal',
          isAd: true,
          status: 'draft',
          caption: '',
          captionStatus: null,
          queuePosition: null,
          sourceSize: d.bayt.length,
          sourceName: d.ad,
          adPosition: konum,
        },
        select: { id: true },
      });
      const anahtar = `clients/${clientId}/ads/${post.id}.jpg`;
      await db.post.updateMany({ where: { id: post.id, status: 'draft' }, data: { imageKey: anahtar } });
      await r2.send(
        new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: anahtar, Body: d.bayt, ContentType: 'image/jpeg' })
      );
      const head = await r2.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: anahtar }));
      if (head.ContentLength !== d.bayt.length) throw new Error(`${d.ad}: R2 boyutu tutmuyor`);
      // `complete` route'unun koşullu geçişi: yalnızca hâlâ taslaksa.
      const bitti = await db.post.updateMany({ where: { id: post.id, status: 'draft' }, data: { status: 'pending' } });
      if (bitti.count !== 1) throw new Error(`${d.ad}: taslak havuza alınamadı`);
      tamam += 1;
      console.log(`  ✓ ${String(tamam).padStart(2)}/${yuklenecek.length} ${d.ad}`);
    }
    console.log(`\n${tamam} reklam havuza eklendi. Reklam ayarı değişmedi; portaldan açılınca yayın başlar.`);
  }
} finally {
  await db.$disconnect();
}
