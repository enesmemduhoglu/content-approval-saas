/**
 * prod-test-verisi-temizligi.mjs
 * ------------------------------------------------------------------
 * NE YAPAR
 * Production veritabanında duran, 22 Temmuz 2026'daki ilk denemelerden
 * kalma çöp test kayıtlarını bulur ve (yalnızca açıkça istenirse) siler.
 * Hedef: `Enes Memduh` / `enes can` adlı ajanslar altında, caption'ı
 * TAM OLARAK "asd" | "gfh" | "as" | "sdf" olan postlar ve — başka postu
 * kalmayan — bunlara bağlı Client kayıtları.
 *
 * NEDEN VARSAYILAN DRY-RUN
 * Bu betik PRODUCTION verisine dokunuyor. Yanlış bir ölçüt ya da yanlış
 * bağlantı adresi geri dönüşü olmayan silme demek. Bu yüzden:
 *   - Bayrak verilmedikçe TEK BİR yazma işlemi bile yapılmaz; sadece SELECT.
 *   - Silme yalnızca `--apply` ile çalışır ve önce aynı raporu basar.
 * Önce dry-run çıktısı insan gözüyle doğrulanır, sonra `--apply` denir.
 *
 * ⚠️ BAĞLANTI TUZAĞI (2026-08-16'da bir kez yakalandı)
 * `.env.local` iki ayrı adres tutuyor:
 *   DATABASE_URL  -> localhost:5455 (Docker, YEREL)
 *   POSTGRES_URL  -> prod Neon (…neon.tech)
 * Prisma'nın varsayılanı `DATABASE_URL` olduğu için, hiçbir şey belirtmeyen
 * bir betik prod'a değil YEREL DB'ye düşer ve "hiçbir kayıt bulunamadı" der.
 * Bu yüzden betik, HERHANGİ BİR SORGUDAN ÖNCE bağlandığı hostu
 * `new URL(url).hostname` ile yazdırır ve prod olduğunu doğrular. Bu adım
 * opsiyonel değildir: host prod görünmüyorsa betik sorgu açmadan çıkar.
 *
 * SİLME GÜVENLİK KURALLARI
 *   1. `publishStatus = 'published'` olan ya da `igMediaId` / `igPermalink`
 *      dolu bir post ASLA silinmez — gerçekten Instagram'a düşmüş olabilir.
 *      Böyle bir aday çıkarsa listede ayrı işaretlenir, kapsam dışı kalır.
 *   2. Tarih koruması: hedef veri 22 Temmuz'dan. `--max-created` sınırından
 *      (varsayılan 2026-08-01) sonra oluşmuş kayıtlar kapsam dışı bırakılır.
 *   3. `Agency` ASLA silinmez. `FURI_API_AGENCY_ID` bir ajansa bağlı;
 *      yanlış ajans silinirse otomasyon sessizce patlar. Ajans temizliği
 *      ayrı ve bilinçli bir karardır.
 *   4. Bir `Client` yalnızca ona bağlı BAŞKA post kalmadıysa silinir.
 *   5. Silme sırası FK bağımlılıklarına göre ve tek transaction içinde:
 *      ApprovalAudit -> ApprovalLink -> PostImage -> Post -> Client
 *
 * KULLANIM
 *   node scripts/prod-test-verisi-temizligi.mjs                    # dry-run (varsayılan)
 *   node scripts/prod-test-verisi-temizligi.mjs --apply            # GERÇEKTEN SİLER
 *   DB_URL_ENV=POSTGRES_URL node scripts/prod-test-verisi-temizligi.mjs
 *
 * BAYRAKLAR
 *   --apply                 Silmeyi gerçekten uygula (yoksa dry-run).
 *   --env-var=ADI           Bağlantı adresinin okunacağı env değişkeni
 *                           (öntanımlı: POSTGRES_URL; DB_URL_ENV ile de verilebilir).
 *   --max-created=YYYY-MM-DD  Bu tarihten sonrası kapsam dışı (öntanımlı 2026-08-01).
 *   --allow-host=host       Prod host doğrulamasını farklı bir hosta izin vererek geçer.
 *                           (localhost buna rağmen reddedilir.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- ölçütler
const HEDEF_AJANS_ADLARI = ['Enes Memduh', 'enes can'];
const HEDEF_CAPTIONLAR = ['asd', 'gfh', 'as', 'sdf']; // TAM eşleşme — LIKE '%asd%' DEĞİL

// ------------------------------------------------------------------ argümanlar
const argv = process.argv.slice(2);
const bayrak = (ad) => argv.includes(`--${ad}`);
const deger = (ad, varsayilan) => {
  const on = `--${ad}=`;
  const bulunan = argv.find((a) => a.startsWith(on));
  return bulunan ? bulunan.slice(on.length) : varsayilan;
};

const APPLY = bayrak('apply');
const ENV_ADI = deger('env-var', process.env.DB_URL_ENV || 'POSTGRES_URL');
const MAX_CREATED = new Date(`${deger('max-created', '2026-08-01')}T00:00:00.000Z`);
const IZINLI_HOST = deger('allow-host', null);

// ------------------------------------------------------- .env dosyalarını oku
// Plain Node betiği; Next.js gibi otomatik env yüklemesi yok. Dosyaları
// Next.js önceliğine yakın sırayla okuyoruz (sonraki öncekini ezer).
function envYukle() {
  const dosyalar = ['.env', '.env.local', '.env.development.local'];
  const harita = {};
  for (const d of dosyalar) {
    const p = path.join(KOK, d);
    if (!fs.existsSync(p)) continue;
    for (const satir of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = satir.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      harita[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  // Gerçek ortam değişkenleri dosyaları ezer (CI / manuel override).
  return { ...harita, ...process.env };
}

// ------------------------------------------------- ZORUNLU: host doğrulaması
function baglantiyiCozVeDogrula() {
  const env = envYukle();
  const url = env[ENV_ADI];

  console.log('='.repeat(72));
  console.log('BAĞLANTI DOĞRULAMASI (sorgudan ÖNCE — zorunlu adım)');
  console.log('='.repeat(72));
  console.log(`  Seçilen env değişkeni : ${ENV_ADI}`);

  if (!url) {
    console.error(`  HATA: ${ENV_ADI} tanımlı değil (.env* dosyalarında da yok).`);
    process.exit(1);
  }

  let host;
  let veritabani;
  try {
    const u = new URL(url);
    host = u.hostname;
    veritabani = u.pathname.replace(/^\//, '');
  } catch {
    console.error(`  HATA: ${ENV_ADI} geçerli bir URL değil.`);
    process.exit(1);
  }

  console.log(`  Bağlanılan host       : ${host}`);
  console.log(`  Veritabanı            : ${veritabani}`);

  // Karşılaştırma için diğer adayları da bas — tuzağı görünür kıl.
  for (const digerAd of ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING']) {
    if (digerAd === ENV_ADI || !env[digerAd]) continue;
    let dh = '(çözülemedi)';
    try {
      dh = new URL(env[digerAd]).hostname;
    } catch {
      /* yok say */
    }
    console.log(`  (bilgi) ${digerAd.padEnd(26)} -> ${dh}`);
  }

  const yerelMi = /^(localhost|127\.|0\.0\.0\.0|::1|host\.docker\.internal)/.test(host);
  const prodMu = host.endsWith('.neon.tech');

  if (yerelMi) {
    console.error('\n  ⛔ DURDURULDU: Host YEREL görünüyor (localhost/Docker).');
    console.error('     Bu betik prod verisi içindir. Doğru env değişkenini seçin:');
    console.error('     DB_URL_ENV=POSTGRES_URL node scripts/prod-test-verisi-temizligi.mjs');
    process.exit(2);
  }
  if (!prodMu && host !== IZINLI_HOST) {
    console.error(`\n  ⛔ DURDURULDU: Host prod (*.neon.tech) değil: ${host}`);
    console.error('     Bilerek yapıyorsanız --allow-host=<host> verin.');
    process.exit(2);
  }

  console.log('\n  ✅ Doğrulandı: prod Neon hostuna bağlanılıyor.');
  console.log(`  Mod: ${APPLY ? '⚠️  APPLY — SİLME YAPILACAK' : 'DRY-RUN (salt-okunur, hiçbir yazma yok)'}`);
  console.log(`  Tarih koruması: createdAt < ${MAX_CREATED.toISOString()}`);
  console.log('');

  return url;
}

// --------------------------------------------------------------- yardımcılar
const kisalt = (s, n = 40) => {
  if (s == null) return '—';
  const tek = String(s).replace(/\s+/g, ' ');
  return tek.length > n ? `${tek.slice(0, n - 1)}…` : tek;
};

function postYaz(p, i) {
  console.log(`  ${String(i + 1).padStart(2)}. post id      : ${p.id}`);
  console.log(`      caption      : ${JSON.stringify(p.caption)}`);
  console.log(`      client       : ${p.client.name} <${p.client.email}> (${p.clientId})`);
  console.log(`      agency       : ${p.agency.name} <${p.agency.email}> (${p.agencyId})`);
  console.log(`      createdAt    : ${p.createdAt.toISOString()}`);
  console.log(`      status       : ${p.status}`);
  console.log(`      publishStatus: ${p.publishStatus}`);
  console.log(`      igMediaId    : ${p.igMediaId ?? '—'}`);
  console.log(`      igPermalink  : ${p.igPermalink ?? '—'}`);
  console.log(`      images       : ${p._count.images} | approvalLink: ${p.approvalLink ? 'var' : 'yok'}`);
  console.log('');
}

// --------------------------------------------------------------------- main
async function main() {
  const url = baglantiyiCozVeDogrula();
  const prisma = new PrismaClient({ datasourceUrl: url });

  try {
    // 1) Hedef ajanslar gerçekten var mı? (adları TAM eşleşme)
    const ajanslar = await prisma.agency.findMany({
      where: { name: { in: HEDEF_AJANS_ADLARI } },
      select: { id: true, name: true, email: true, createdAt: true, _count: { select: { posts: true, clients: true } } },
    });

    console.log('='.repeat(72));
    console.log('1) HEDEF AJANSLAR (SİLİNMEYECEK — sadece kapsam belirlemek için)');
    console.log('='.repeat(72));
    if (ajanslar.length === 0) {
      console.log('  Hedef adla eşleşen ajans YOK. Ölçüt boş küme döndürecek.');
    }
    for (const a of ajanslar) {
      console.log(
        `  - ${a.name} <${a.email}> id=${a.id} | post=${a._count.posts} client=${a._count.clients} | ${a.createdAt.toISOString()}`,
      );
    }
    console.log('');

    const ajansIdleri = ajanslar.map((a) => a.id);

    // 2) Dar ölçüt: hedef ajans + TAM caption eşleşmesi
    const secim = {
      id: true,
      caption: true,
      status: true,
      publishStatus: true,
      igMediaId: true,
      igPermalink: true,
      publishedAt: true,
      externalRef: true,
      createdAt: true,
      clientId: true,
      agencyId: true,
      client: { select: { id: true, name: true, email: true } },
      agency: { select: { id: true, name: true, email: true } },
      approvalLink: { select: { id: true } },
      _count: { select: { images: true } },
    };

    const adaylar = ajansIdleri.length
      ? await prisma.post.findMany({
          where: { agencyId: { in: ajansIdleri }, caption: { in: HEDEF_CAPTIONLAR } },
          select: secim,
          orderBy: { createdAt: 'asc' },
        })
      : [];

    console.log('='.repeat(72));
    console.log('2) ÖLÇÜTE UYAN POSTLAR');
    console.log(`   ajans ∈ [${HEDEF_AJANS_ADLARI.join(', ')}]  VE  caption ∈ [${HEDEF_CAPTIONLAR.join(', ')}]`);
    console.log('   (TAM eşleşme — kör LIKE %asd% kullanılmadı)');
    console.log('='.repeat(72));
    console.log(`  Toplam eşleşen: ${adaylar.length}`);
    console.log('');
    adaylar.forEach(postYaz);

    // 3) Koruma filtreleri
    const korunanYayin = adaylar.filter(
      (p) => p.publishStatus === 'published' || p.igMediaId || p.igPermalink,
    );
    const korunanTarih = adaylar.filter(
      (p) => !korunanYayin.includes(p) && p.createdAt >= MAX_CREATED,
    );
    const silinecek = adaylar.filter((p) => !korunanYayin.includes(p) && !korunanTarih.includes(p));

    console.log('='.repeat(72));
    console.log('3) KORUMA FİLTRELERİ — KAPSAM DIŞI BIRAKILANLAR');
    console.log('='.repeat(72));
    console.log(`  a) Yayınlanmış / IG izi olan (ASLA silinmez): ${korunanYayin.length}`);
    korunanYayin.forEach((p) =>
      console.log(
        `     ! ${p.id} | ${JSON.stringify(p.caption)} | publishStatus=${p.publishStatus} | igMediaId=${p.igMediaId ?? '—'} | igPermalink=${p.igPermalink ?? '—'}`,
      ),
    );
    console.log(`  b) Tarih sınırından yeni (createdAt >= ${MAX_CREATED.toISOString()}): ${korunanTarih.length}`);
    korunanTarih.forEach((p) =>
      console.log(`     ! ${p.id} | ${JSON.stringify(p.caption)} | ${p.createdAt.toISOString()}`),
    );
    console.log('');

    // 4) Bağlı Client'lar — yalnızca başka postu kalmayanlar silinebilir
    const silinecekPostIdleri = silinecek.map((p) => p.id);
    const etkilenenClientIdleri = [...new Set(silinecek.map((p) => p.clientId))];

    const clientDurumlari = [];
    for (const cid of etkilenenClientIdleri) {
      const client = await prisma.client.findUnique({
        where: { id: cid },
        select: {
          id: true,
          name: true,
          email: true,
          createdAt: true,
          instagramUserId: true,
          agency: { select: { name: true } },
          _count: { select: { posts: true } },
        },
      });
      const kalan = await prisma.post.count({
        where: { clientId: cid, id: { notIn: silinecekPostIdleri.length ? silinecekPostIdleri : ['__yok__'] } },
      });
      clientDurumlari.push({ client, kalan, silinebilir: kalan === 0 });
    }

    console.log('='.repeat(72));
    console.log('4) ETKİLENEN CLIENT KAYITLARI');
    console.log('='.repeat(72));
    if (clientDurumlari.length === 0) console.log('  (yok)');
    for (const c of clientDurumlari) {
      console.log(
        `  - ${c.client.name} <${c.client.email}> id=${c.client.id} | ajans=${c.client.agency.name} | toplam post=${c.client._count.posts} | silme sonrası kalan=${c.kalan} | IG bağlı=${c.client.instagramUserId ? 'EVET' : 'hayır'} => ${c.silinebilir ? 'SİLİNECEK' : 'KORUNACAK (başka postu var)'}`,
      );
    }
    console.log('');

    // 5) Bağlı alt kayıtların sayısı
    const audits = silinecekPostIdleri.length
      ? await prisma.approvalAudit.count({ where: { postId: { in: silinecekPostIdleri } } })
      : 0;
    const links = silinecekPostIdleri.length
      ? await prisma.approvalLink.count({ where: { postId: { in: silinecekPostIdleri } } })
      : 0;
    const images = silinecekPostIdleri.length
      ? await prisma.postImage.count({ where: { postId: { in: silinecekPostIdleri } } })
      : 0;
    const silinecekClientIdleri = clientDurumlari.filter((c) => c.silinebilir).map((c) => c.client.id);

    console.log('='.repeat(72));
    console.log('5) ÖZET');
    console.log('='.repeat(72));
    console.log(`  Ölçüte uyan post           : ${adaylar.length}`);
    console.log(`  Kapsam dışı (yayın izi)    : ${korunanYayin.length}`);
    console.log(`  Kapsam dışı (tarih)        : ${korunanTarih.length}`);
    console.log(`  SİLİNECEK post             : ${silinecek.length}`);
    console.log(`  SİLİNECEK ApprovalAudit    : ${audits}`);
    console.log(`  SİLİNECEK ApprovalLink     : ${links}`);
    console.log(`  SİLİNECEK PostImage        : ${images}`);
    console.log(`  SİLİNECEK Client           : ${silinecekClientIdleri.length}`);
    console.log('  SİLİNECEK Agency           : 0 (ajanslara asla dokunulmaz)');
    console.log('');

    // 6) Uygula ya da dur
    if (!APPLY) {
      console.log('='.repeat(72));
      console.log('DRY-RUN BİTTİ — hiçbir yazma işlemi yapılmadı (sadece SELECT).');
      console.log('Silmek için, çıktı doğrulandıktan sonra:');
      console.log('  node scripts/prod-test-verisi-temizligi.mjs --apply');
      console.log('='.repeat(72));
      return;
    }

    if (silinecek.length === 0) {
      console.log('Silinecek kayıt yok — çıkılıyor.');
      return;
    }

    console.log('⚠️  APPLY modu: silme tek transaction içinde uygulanıyor…');
    const sonuc = await prisma.$transaction(async (tx) => {
      const a = await tx.approvalAudit.deleteMany({ where: { postId: { in: silinecekPostIdleri } } });
      const l = await tx.approvalLink.deleteMany({ where: { postId: { in: silinecekPostIdleri } } });
      const i = await tx.postImage.deleteMany({ where: { postId: { in: silinecekPostIdleri } } });
      const p = await tx.post.deleteMany({ where: { id: { in: silinecekPostIdleri } } });

      // Client'ları silmeden önce transaction İÇİNDE tekrar doğrula:
      // arada yeni post gelmiş olabilir.
      let c = 0;
      for (const cid of silinecekClientIdleri) {
        const kalan = await tx.post.count({ where: { clientId: cid } });
        if (kalan === 0) {
          await tx.client.delete({ where: { id: cid } });
          c += 1;
        } else {
          console.log(`  (atlandı) Client ${cid} — transaction içinde ${kalan} post bulundu.`);
        }
      }
      return { audits: a.count, links: l.count, images: i.count, posts: p.count, clients: c };
    });

    console.log('SİLME TAMAM:', JSON.stringify(sonuc));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('BETİK HATASI:', e);
  process.exit(1);
});
