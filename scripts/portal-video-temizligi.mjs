/**
 * portal-video-temizligi.mjs
 * ------------------------------------------------------------------
 * NE YAPAR
 * Bir müşterinin PORTALDAN yüklenmiş (`source = 'portal'`) tüm videolarını
 * siler: kuyruktakiler, kuyruktan çıkarılanlar ve geçmiş (yayınlanan /
 * yayınlanamayan). Canlı test videolarını temizleyip müşteriye boş bir
 * portal teslim etmek için yazıldı (2026-09-25).
 *
 * Instagram'a DOKUNMAZ: yayınlanmış bir Reel Instagram'da kalır, yalnızca
 * portaldaki kaydı gider. Ajans panelinden gelen postlar (`source = 'agency'`)
 * kapsam dışıdır.
 *
 * VARSAYILAN DRY-RUN
 * Bayrak verilmedikçe tek bir yazma yapılmaz; yalnızca liste basılır.
 * `--apply` önce aynı listeyi basar, sonra siler.
 *
 * BAĞLANTI: `.env.local`'deki `POSTGRES_URL` (prod Neon). `DATABASE_URL`
 * yereli gösterir — bkz. prod-test-verisi-temizligi.mjs'teki tuzak notu.
 * Host `neon.tech` değilse betik sorgu açmadan çıkar.
 *
 * SİLME SIRASI (tek transaction):
 *   SlotRun.postId → null (slot kaydı kalır; tick geçmiş slotu yeniden
 *   koşmasın), PostRevision → ApprovalAudit → PostImage → ApprovalLink → Post.
 * Transaction başarılıysa R2'deki video ve kare nesneleri silinir (R2 hatası
 * DB silmesini geri almaz; kalan nesneler raporlanır).
 *
 * KULLANIM
 *   node scripts/portal-video-temizligi.mjs                          # dry-run, "Furkan Teacher"
 *   node scripts/portal-video-temizligi.mjs --apply                  # GERÇEKTEN SİLER
 *   node scripts/portal-video-temizligi.mjs --client="Başka Müşteri"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const MUSTERI = (argv.find((a) => a.startsWith('--client=')) ?? '--client=Furkan Teacher').slice(9);

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

const db = new PrismaClient({ datasources: { db: { url } } });

function kategori(p) {
  if (p.publishStatus === 'published' || p.publishStatus === 'failed') return 'geçmiş';
  if (p.queuePosition === null) return p.status === 'draft' ? 'taslak' : 'kuyruk dışı';
  return 'kuyruk';
}

try {
  const clients = await db.client.findMany({ where: { name: MUSTERI }, select: { id: true, name: true } });
  if (clients.length !== 1) {
    console.error(`"${MUSTERI}" adlı tam 1 müşteri bekleniyordu, ${clients.length} bulundu.`);
    process.exit(1);
  }
  const client = clients[0];

  const posts = await db.post.findMany({
    where: { clientId: client.id, source: 'portal' },
    select: {
      id: true,
      status: true,
      publishStatus: true,
      queuePosition: true,
      igPermalink: true,
      videoKey: true,
      frameKeys: true,
      createdAt: true,
      caption: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Yayın kilidi alınmış (tick şu an yayınlıyor) postlara dokunulmaz.
  const kilitli = posts.filter((p) => p.publishStatus === 'publishing');
  const hedef = posts.filter((p) => p.publishStatus !== 'publishing');

  console.log(`\nMüşteri: ${client.name} (${client.id}) — ${posts.length} portal videosu\n`);
  for (const p of posts) {
    const k = p.publishStatus === 'publishing' ? 'ATLANDI (yayınlanıyor)' : kategori(p);
    const cap = p.caption.replace(/\s+/g, ' ').slice(0, 50);
    console.log(
      `  [${k}] ${p.id} · ${p.createdAt.toISOString().slice(0, 16)} · ${p.status}/${p.publishStatus}` +
        `${p.igPermalink ? ` · IG: ${p.igPermalink}` : ''} · "${cap}"`
    );
  }
  if (kilitli.length) console.log(`\n${kilitli.length} video şu an yayınlanıyor, atlandı.`);

  const ids = hedef.map((p) => p.id);
  const anahtarlar = hedef.flatMap((p) => [p.videoKey, ...p.frameKeys]).filter(Boolean);
  const slotRuns = await db.slotRun.count({ where: { postId: { in: ids } } });
  console.log(`\nSilinecek: ${ids.length} post · ${anahtarlar.length} R2 nesnesi · ${slotRuns} slot kaydının post bağı kopacak`);

  if (!APPLY) {
    console.log('\nDRY-RUN: hiçbir şey silinmedi. Silmek için --apply ekle.');
    process.exit(0);
  }
  if (ids.length === 0) {
    console.log('Silinecek bir şey yok.');
    process.exit(0);
  }

  const silinen = await db.$transaction(async (tx) => {
    await tx.slotRun.updateMany({ where: { postId: { in: ids } }, data: { postId: null } });
    await tx.postRevision.deleteMany({ where: { postId: { in: ids } } });
    await tx.approvalAudit.deleteMany({ where: { postId: { in: ids } } });
    await tx.postImage.deleteMany({ where: { postId: { in: ids } } });
    await tx.approvalLink.deleteMany({ where: { postId: { in: ids } } });
    const r = await tx.post.deleteMany({
      where: { id: { in: ids }, clientId: client.id, source: 'portal', NOT: { publishStatus: 'publishing' } },
    });
    return r.count;
  });
  console.log(`\nDB: ${silinen} post silindi.`);

  if (anahtarlar.length) {
    const r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    });
    let hatali = 0;
    for (let i = 0; i < anahtarlar.length; i += 1000) {
      const parca = anahtarlar.slice(i, i + 1000);
      const out = await r2.send(
        new DeleteObjectsCommand({
          Bucket: env.R2_BUCKET,
          Delete: { Objects: parca.map((Key) => ({ Key })), Quiet: true },
        })
      );
      hatali += out.Errors?.length ?? 0;
      for (const e of out.Errors ?? []) console.log(`  R2 silinemedi: ${e.Key} — ${e.Code}`);
    }
    console.log(`R2: ${anahtarlar.length - hatali}/${anahtarlar.length} nesne silindi.`);
  }
} finally {
  await db.$disconnect();
}
