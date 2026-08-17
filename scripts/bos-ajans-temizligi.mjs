/**
 * bos-ajans-temizligi.mjs
 * ------------------------------------------------------------------
 * NE YAPAR
 * Production veritabanında duran, 22 Temmuz 2026'daki ilk denemelerden
 * kalma ve içi TAMAMEN BOŞ olan iki test ajansını siler:
 *
 *   - `Enes Memduh` <eneshan0098@gmail.com>  id=cmrw9cu730000l404sekzspv4
 *   - `enes can`    <eneshan032@gmail.com>   id=cmrwa781m0001ky04liyy3f5d
 *
 * "Boş" = ajansa bağlı 0 Post ve 0 Client. Bu betik dolu bir ajansı ASLA
 * silmez; dolu çıkarsa o ajansı kapsam dışı bırakıp sebebini yazar.
 *
 * NEDEN AYRI BİR BETİK
 * Kardeş betik `prod-test-verisi-temizligi.mjs` bilinçli bir kuralla
 * `Agency` kaydına HİÇ dokunmuyor (bkz. o dosyadaki 3. güvenlik kuralı):
 * `FURI_API_AGENCY_ID` canlı bir ajansa bağlı ve yanlış ajans silinirse
 * furi otomasyonu sessizce patlar. Ajans silmek ayrı ve bilinçli bir
 * karardır — bu yüzden ayrı dosya, ayrı emniyet zinciri.
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
 * EMNİYET ZİNCİRİ (hepsi silmeden ÖNCE, sırayla)
 *   1. Host doğrulaması: prod (*.neon.tech) değilse tek sorgu açmadan exit 2.
 *   2. Varsayılan DRY-RUN: `--apply` verilmedikçe tek bir yazma bile yok.
 *   3. KARA LİSTE: canlı ajans `Enes MEMDUHOĞLU`
 *      (cmsw2ajnq0000jm04d6m9puei) ve adı hiçbir koşulda silinemez. Statik
 *      liste bile kara listeyle kesişiyorsa betik daha DB'ye bağlanmadan durur.
 *   4. `FURI_API_AGENCY_ID` koruması: env'de tanımlıysa ve değeri silinecek
 *      listedeki bir id ile eşleşiyorsa betik HİÇBİR ŞEY silmeden durur.
 *      Bu, zincirin en kritik halkası — otomasyonun bağlı olduğu ajans.
 *      Dikkat: bu değer YEREL `.env.local`den gelir ve orada dev değeri
 *      (`dev-agency-a`) duruyor olabilir; gerçek prod değeri Vercel env'inde.
 *      Bu yüzden betik, okunan değer prod'daki hiçbir ajansla eşleşmiyorsa
 *      "bu teyit yanıltıcı" diye ayrıca uyarır. Asıl koruma 3. kuraldaki
 *      kara listedir.
 *   5. Hedefleme ADA göre değil ID'ye göre: ad değişebilir, id değişmez.
 *      Ama ad da TEYİT edilir; beklenenle uyuşmuyorsa betik durur (yanlış
 *      ortama ya da yanlış id'ye bakıyor olabiliriz).
 *   6. Boşluk kontrolü: post>0 veya client>0 olan ajans kapsam dışı.
 *   7. FK haritası doğrulaması: `information_schema`'dan `Agency`'yi işaret
 *      eden tüm foreign key'ler okunur. Şemada bilinen tablolar (Client,
 *      Post) dışında bir tablo çıkarsa betik durur — silme sırası eksik
 *      kalmasın diye. (Şu an `Agency`'ye FK ile bağlı yalnızca bu ikisi var;
 *      ApiKey/branding gibi ayrı tablo yok, branding alanları `Agency`
 *      satırının kendi kolonları: logoUrl, brandColor.)
 *   8. Silme TEK transaction içinde ve transaction İÇİNDE tekrar doğrulanır:
 *      ad + kara liste + post sayısı + client sayısı yeniden okunur. Arada
 *      veri gelmişse o ajans atlanır ve sebebi yazılır.
 *
 * SİLME SIRASI
 * Yalnızca 0 post / 0 client olan ajans silindiğinden alt tablo temizliği
 * (ApprovalAudit -> ApprovalLink -> PostImage -> Post -> Client) bu betiğin
 * kapsamında DEĞİLDİR; o iş kardeş betiğe ait. Burada tek DELETE: Agency.
 *
 * KULLANIM
 *   node scripts/bos-ajans-temizligi.mjs                     # dry-run (varsayılan)
 *   node scripts/bos-ajans-temizligi.mjs --apply             # GERÇEKTEN SİLER
 *   DB_URL_ENV=POSTGRES_URL node scripts/bos-ajans-temizligi.mjs
 *
 * BAYRAKLAR
 *   --apply                 Silmeyi gerçekten uygula (yoksa dry-run).
 *   --env-var=ADI           Bağlantı adresinin okunacağı env değişkeni
 *                           (öntanımlı: POSTGRES_URL; DB_URL_ENV ile de verilebilir).
 *   --env-dir=YOL           .env* dosyalarının aranacağı dizin (öntanımlı: repo kökü).
 *                           Git worktree içinden çalıştırırken ana repo kökünü verin.
 *   --allow-host=host       Prod host doğrulamasını farklı bir hosta izin vererek geçer.
 *                           (localhost buna rağmen reddedilir.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------- hedefler
// ID ile hedefliyoruz (ad değişebilir, id değişmez); `ad` yalnızca teyit içindir.
const HEDEFLER = [
  { id: 'cmrw9cu730000l404sekzspv4', ad: 'Enes Memduh', eposta: 'eneshan0098@gmail.com' },
  { id: 'cmrwa781m0001ky04liyy3f5d', ad: 'enes can', eposta: 'eneshan032@gmail.com' },
];

// ---------------------------------------------------------------- KARA LİSTE
// Canlı ajans. FURI_API_AGENCY_ID buna bağlı; hiçbir koşulda silinmez.
const KARA_LISTE_IDLER = ['cmsw2ajnq0000jm04d6m9puei'];
const KARA_LISTE_ADLAR = ['Enes MEMDUHOĞLU'];

// `Agency`'yi işaret eden, şemadan bilinen tablolar. Bunun dışında bir FK
// çıkarsa betik durur (7. emniyet kuralı).
const BILINEN_FK_TABLOLARI = ['Client', 'Post'];

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
const ENV_DIZINI = path.resolve(deger('env-dir', KOK));
const IZINLI_HOST = deger('allow-host', null);

// ------------------------------------------------------- .env dosyalarını oku
// Plain Node betiği; Next.js gibi otomatik env yüklemesi yok. Dosyaları
// Next.js önceliğine yakın sırayla okuyoruz (sonraki öncekini ezer).
function envYukle() {
  const dosyalar = ['.env', '.env.local', '.env.development.local'];
  const harita = {};
  for (const d of dosyalar) {
    const p = path.join(ENV_DIZINI, d);
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

// --------------------------------------------- 3. kural: statik kara liste
// DB'ye bağlanmadan önce çalışır: hedef listesinin kendisi bozuksa hiç başlama.
function karaListeyiDogrula() {
  console.log('='.repeat(72));
  console.log('KARA LİSTE KONTROLÜ (DB bağlantısından ÖNCE)');
  console.log('='.repeat(72));
  console.log(`  Korunan id(ler)  : ${KARA_LISTE_IDLER.join(', ')}`);
  console.log(`  Korunan ad(lar)  : ${KARA_LISTE_ADLAR.join(', ')}`);

  const carpisan = HEDEFLER.filter(
    (h) => KARA_LISTE_IDLER.includes(h.id) || KARA_LISTE_ADLAR.includes(h.ad),
  );
  if (carpisan.length) {
    console.error('\n  ⛔ DURDURULDU: Hedef listesi kara listeyle çakışıyor:');
    carpisan.forEach((h) => console.error(`     - ${h.ad} (${h.id})`));
    process.exit(2);
  }
  console.log('  ✅ Hedef listesi kara listeyle çakışmıyor.\n');
}

// ------------------------------------------------- 1. kural: host doğrulaması
function baglantiyiCozVeDogrula(env) {
  const url = env[ENV_ADI];

  console.log('='.repeat(72));
  console.log('BAĞLANTI DOĞRULAMASI (sorgudan ÖNCE — zorunlu adım)');
  console.log('='.repeat(72));
  console.log(`  Seçilen env değişkeni : ${ENV_ADI}`);
  console.log(`  .env* dizini          : ${ENV_DIZINI}`);

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
    console.error('     DB_URL_ENV=POSTGRES_URL node scripts/bos-ajans-temizligi.mjs');
    process.exit(2);
  }
  if (!prodMu && host !== IZINLI_HOST) {
    console.error(`\n  ⛔ DURDURULDU: Host prod (*.neon.tech) değil: ${host}`);
    console.error('     Bilerek yapıyorsanız --allow-host=<host> verin.');
    process.exit(2);
  }

  console.log('\n  ✅ Doğrulandı: prod Neon hostuna bağlanılıyor.');
  console.log(`  Mod: ${APPLY ? '⚠️  APPLY — SİLME YAPILACAK' : 'DRY-RUN (salt-okunur, hiçbir yazma yok)'}`);
  console.log('');

  return url;
}

// -------------------------------------- 4. kural: FURI_API_AGENCY_ID koruması
function furiKorumasiniDogrula(env) {
  const furiId = env.FURI_API_AGENCY_ID;

  console.log('='.repeat(72));
  console.log('FURI_API_AGENCY_ID KORUMASI');
  console.log('='.repeat(72));

  if (!furiId) {
    console.log('  FURI_API_AGENCY_ID env\'de tanımlı DEĞİL.');
    console.log('  (Uyarı: bu betik prod env\'ini göremiyor olabilir; kara liste yine de');
    console.log('   canlı ajansı koruyor. Yine de Vercel prod env\'inde hangi ajansın');
    console.log('   bağlı olduğunu teyit etmeden --apply demeyin.)');
    console.log('');
    return null;
  }

  console.log(`  FURI_API_AGENCY_ID    : ${furiId}`);
  const carpisan = HEDEFLER.find((h) => h.id === furiId);
  if (carpisan) {
    console.error('\n  ⛔ DURDURULDU: Silinecek listedeki bir ajans furi otomasyonuna bağlı!');
    console.error(`     ${carpisan.ad} (${carpisan.id}) === FURI_API_AGENCY_ID`);
    console.error('     Hiçbir şey silinmedi. Önce FURI_API_AGENCY_ID doğru ajansa taşınmalı.');
    process.exit(2);
  }
  console.log('  ✅ Silinecek ajansların hiçbiri furi otomasyonuna bağlı değil.\n');
  return furiId;
}

// ------------------------------- 7. kural: Agency'ye bağlı FK haritası teyidi
async function fkHaritasiniDogrula(prisma) {
  const satirlar = await prisma.$queryRaw`
    SELECT DISTINCT tc.table_name AS kaynak_tablo, kcu.column_name AS kaynak_kolon
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_name = 'Agency'
    ORDER BY 1, 2
  `;

  console.log('='.repeat(72));
  console.log('AGENCY\'YE FK İLE BAĞLI TABLOLAR (silme sırası teyidi)');
  console.log('='.repeat(72));
  if (satirlar.length === 0) console.log('  (hiç yok)');
  for (const s of satirlar) {
    console.log(`  - ${s.kaynak_tablo}.${s.kaynak_kolon}`);
  }

  const bilinmeyen = satirlar
    .map((s) => s.kaynak_tablo)
    .filter((t) => !BILINEN_FK_TABLOLARI.includes(t));
  if (bilinmeyen.length) {
    console.error(`\n  ⛔ DURDURULDU: Bilinmeyen bağlı tablo(lar): ${[...new Set(bilinmeyen)].join(', ')}`);
    console.error('     Betik bu tabloların silme sırasını bilmiyor. Önce betik güncellenmeli.');
    process.exit(2);
  }
  console.log('  ✅ Yalnızca bilinen tablolar bağlı (Client, Post) — boş ajans için ek temizlik gerekmiyor.\n');
}

// --------------------------------------------------------------------- main
async function main() {
  karaListeyiDogrula();

  const env = envYukle();
  const url = baglantiyiCozVeDogrula(env);
  const furiId = furiKorumasiniDogrula(env);

  const prisma = new PrismaClient({ datasourceUrl: url });

  try {
    await fkHaritasiniDogrula(prisma);

    // 1) Tam envanter — neyin silineceğini bağlamıyla görelim.
    const tumAjanslar = await prisma.agency.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        _count: { select: { posts: true, clients: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    console.log('='.repeat(72));
    console.log('1) PROD AJANS ENVANTERİ (tamamı)');
    console.log('='.repeat(72));
    for (const a of tumAjanslar) {
      const hedefMi = HEDEFLER.some((h) => h.id === a.id);
      const karaMi = KARA_LISTE_IDLER.includes(a.id) || KARA_LISTE_ADLAR.includes(a.name);
      const etiket = karaMi ? '🔒 KORUNAN' : hedefMi ? '🎯 HEDEF' : '   —';
      console.log(
        `  ${etiket}  ${String(a.name)} <${a.email}> id=${a.id} | post=${a._count.posts} client=${a._count.clients} | ${a.createdAt.toISOString()}`,
      );
    }
    console.log('');

    // 1b) FURI_API_AGENCY_ID env'den okundu ama YEREL dosyadan gelmiş olabilir.
    // Prod'daki hiçbir ajansla eşleşmiyorsa, o değer prod'un gerçeği DEĞİLDİR ve
    // yukarıdaki "✅ bağlı değil" teyidi yanıltıcı olur. Bunu yüksek sesle söyle.
    if (furiId && !tumAjanslar.some((a) => a.id === furiId)) {
      console.log('='.repeat(72));
      console.log('⚠️  FURI_API_AGENCY_ID UYARISI');
      console.log('='.repeat(72));
      console.log(`  Okunan değer "${furiId}" prod'daki HİÇBİR ajansla eşleşmiyor.`);
      console.log('  Demek ki yerel .env* dosyasından geldi; prod (Vercel) env\'i bu değil.');
      console.log('  Silinecek ajansların furi\'ye bağlı olmadığını Vercel prod env\'inden');
      console.log('  ayrıca teyit edin. (Kara liste canlı ajansı yine de koruyor.)');
      console.log('');
    }

    // 2) Hedefleri tek tek doğrula: var mı, adı uyuşuyor mu, boş mu.
    console.log('='.repeat(72));
    console.log('2) HEDEF AJANS DOĞRULAMASI (id ile hedefleme, ad ile teyit)');
    console.log('='.repeat(72));

    const silinecekler = [];
    const kapsamDisi = [];
    let adUyusmazligi = false;

    for (const h of HEDEFLER) {
      const a = tumAjanslar.find((x) => x.id === h.id);
      console.log(`  - beklenen: ${h.ad} <${h.eposta}> id=${h.id}`);

      if (!a) {
        console.log('      durum   : ⚪ BULUNAMADI — daha önce silinmiş olabilir, kapsam dışı.');
        kapsamDisi.push({ hedef: h, sebep: 'kayıt bulunamadı' });
        console.log('');
        continue;
      }

      console.log(`      bulunan : ${String(a.name)} <${a.email}>`);
      console.log(`      sayımlar: post=${a._count.posts} client=${a._count.clients}`);
      console.log(`      oluşma  : ${a.createdAt.toISOString()}`);

      if (KARA_LISTE_IDLER.includes(a.id) || KARA_LISTE_ADLAR.includes(a.name)) {
        console.error('      durum   : ⛔ KARA LİSTEDE — bu asla olmamalıydı, betik duruyor.');
        process.exit(2);
      }
      if (a.name !== h.ad) {
        console.error(`      durum   : ⛔ AD UYUŞMUYOR (beklenen "${h.ad}", bulunan "${String(a.name)}")`);
        adUyusmazligi = true;
      } else if (a.email !== h.eposta) {
        // E-posta uyuşmazlığı tek başına durdurmuyor: ad + id zaten eşleşti.
        console.log(`      uyarı   : ⚠️  E-posta beklenenden farklı (beklenen ${h.eposta}).`);
      }

      if (a._count.posts > 0 || a._count.clients > 0) {
        console.log('      durum   : ⚠️  BOŞ DEĞİL — kapsam dışı, silinmeyecek.');
        kapsamDisi.push({ hedef: h, sebep: `boş değil (post=${a._count.posts}, client=${a._count.clients})` });
      } else if (a.name === h.ad) {
        console.log('      durum   : ✅ boş ve teyitli — SİLİNECEK');
        silinecekler.push({ hedef: h, ajans: a });
      }
      console.log('');
    }

    if (adUyusmazligi) {
      console.error('='.repeat(72));
      console.error('⛔ DURDURULDU: En az bir hedefin adı beklenenle uyuşmuyor.');
      console.error('   Yanlış ortama ya da yanlış id\'ye bakıyor olabiliriz. Hiçbir şey silinmedi.');
      console.error('='.repeat(72));
      process.exit(2);
    }

    // 3) Özet
    console.log('='.repeat(72));
    console.log('3) ÖZET');
    console.log('='.repeat(72));
    console.log(`  Prod'daki toplam ajans     : ${tumAjanslar.length}`);
    console.log(`  SİLİNECEK Agency           : ${silinecekler.length}`);
    silinecekler.forEach((s) => console.log(`     - ${s.ajans.name} <${s.ajans.email}> (${s.ajans.id})`));
    console.log(`  Kapsam dışı hedef          : ${kapsamDisi.length}`);
    kapsamDisi.forEach((k) => console.log(`     ! ${k.hedef.ad} (${k.hedef.id}) — ${k.sebep}`));
    console.log('  SİLİNECEK Post / Client    : 0 (boş olmayan ajans zaten silinmiyor)');
    console.log('');

    // 4) Uygula ya da dur
    if (!APPLY) {
      console.log('='.repeat(72));
      console.log('DRY-RUN BİTTİ — hiçbir yazma işlemi yapılmadı (sadece SELECT).');
      console.log('Silmek için, çıktı doğrulandıktan sonra:');
      console.log('  node scripts/bos-ajans-temizligi.mjs --apply');
      console.log('='.repeat(72));
      return;
    }

    if (silinecekler.length === 0) {
      console.log('Silinecek ajans yok — çıkılıyor.');
      return;
    }

    console.log('⚠️  APPLY modu: silme tek transaction içinde uygulanıyor…');
    const sonuc = await prisma.$transaction(async (tx) => {
      const silinen = [];
      const atlanan = [];

      for (const { hedef } of silinecekler) {
        // Transaction İÇİNDE yeniden doğrula — dry-run ile apply arasında
        // veri gelmiş olabilir.
        const a = await tx.agency.findUnique({
          where: { id: hedef.id },
          select: { id: true, name: true, email: true },
        });
        if (!a) {
          atlanan.push(`${hedef.id} — kayıt yok (arada silinmiş)`);
          continue;
        }
        if (KARA_LISTE_IDLER.includes(a.id) || KARA_LISTE_ADLAR.includes(a.name)) {
          atlanan.push(`${a.id} — KARA LİSTEDE`);
          continue;
        }
        if (a.name !== hedef.ad) {
          atlanan.push(`${a.id} — ad uyuşmuyor (bulunan "${String(a.name)}")`);
          continue;
        }

        const postSayisi = await tx.post.count({ where: { agencyId: a.id } });
        const clientSayisi = await tx.client.count({ where: { agencyId: a.id } });
        if (postSayisi > 0 || clientSayisi > 0) {
          atlanan.push(`${a.id} — artık boş değil (post=${postSayisi}, client=${clientSayisi})`);
          continue;
        }

        await tx.agency.delete({ where: { id: a.id } });
        silinen.push(`${a.name} <${a.email}> (${a.id})`);
      }

      return { silinen, atlanan };
    });

    console.log('');
    console.log('SİLİNEN AJANSLAR:');
    if (sonuc.silinen.length === 0) console.log('  (yok)');
    sonuc.silinen.forEach((s) => console.log(`  ✅ ${s}`));
    console.log('ATLANAN AJANSLAR:');
    if (sonuc.atlanan.length === 0) console.log('  (yok)');
    sonuc.atlanan.forEach((s) => console.log(`  ⏭️  ${s}`));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('BETİK HATASI:', e);
  process.exit(1);
});
