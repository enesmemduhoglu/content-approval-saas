/**
 * token-sifrele.mjs
 * ------------------------------------------------------------------
 * NE YAPAR
 * `Client.instagramAccessToken` sütununda DÜZ METİN duran kayıtları bulur ve
 * (yalnızca açıkça istenirse) AES-256-GCM ile şifreleyip yerine yazar (S1).
 *
 * NEDEN GEREKLİ
 * `src/lib/crypto.ts` geçişi kesintisiz yapıyor: `enc:v1:` öneki olmayan değer
 * düz metin kabul edilip okunuyor ve her YAZMADA şifreliye dönüyor. Ama yazma
 * ancak hesap yeniden bağlanınca ya da cron token'ı yenileyince oluyor —
 * prod'daki tek müşterinin token'ı 2026-10-15'te doluyor, yani cron ona
 * ~2026-09-25'e kadar dokunmayacak. O zamana kadar kayıt düz metin kalırdı,
 * yani S1 prod'da gerçekte kapanmamış olurdu. Bu betik o beklemeyi kaldırır.
 *
 * NEDEN VARSAYILAN DRY-RUN
 * Production verisine yazıyor ve yazdığı şey bir SIR. Yanlış anahtarla
 * şifrelenen token geri döndürülemez — okunamaz hâle gelir ve hesabın
 * panelden yeniden bağlanması gerekir. Bu yüzden:
 *   - Bayrak verilmedikçe TEK BİR yazma işlemi bile yapılmaz; sadece SELECT.
 *   - `--apply` her kaydı yazdıktan HEMEN SONRA geri okuyup çözer ve orijinaliyle
 *     karşılaştırır; eşleşmezse transaction geri alınır.
 *
 * ⚠️ BAĞLANTI TUZAĞI (kardeş betikle aynı)
 * `.env.local` iki ayrı adres tutuyor: `DATABASE_URL` -> localhost (Docker),
 * prod Neon adresi `POSTGRES_URL` altında. Betik HERHANGİ BİR SORGUDAN ÖNCE
 * bağlandığı hostu yazdırır ve prod olduğunu doğrular.
 *
 * ⚠️ ANAHTAR TUZAĞI
 * Şifreleme `ENCRYPTION_KEY` ile yapılır. Bu betiği YEREL anahtarla koşup
 * prod'a yazmak, prod'un okuyamayacağı kayıtlar üretir. Betik bu yüzden
 * kullandığı anahtarın SHA-256 parmak izinin ilk 8 karakterini basar —
 * Vercel'deki değerle karşılaştırılabilsin diye. Anahtarın kendisi basılmaz.
 *
 * KULLANIM
 *   node scripts/token-sifrele.mjs                     # dry-run (varsayılan)
 *   node scripts/token-sifrele.mjs --apply             # GERÇEKTEN yazar
 *   node scripts/token-sifrele.mjs --env-var=DATABASE_URL --allow-host=localhost
 *
 * BAYRAKLAR
 *   --apply            Şifrelemeyi gerçekten uygula (yoksa dry-run).
 *   --env-var=ADI      Bağlantı adresinin okunacağı env değişkeni
 *                      (öntanımlı: POSTGRES_URL; DB_URL_ENV ile de verilebilir).
 *   --allow-host=host  Prod host doğrulamasını farklı bir hosta izin vererek geçer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// src/lib/crypto.ts ile AYNI biçim. Betik plain Node olduğu için TS modülünü
// içe aktaramıyor; bu yüzden kopyalanan tek şey bu üç sabit ve iki fonksiyon.
// Uyuşmazlık riski testle kapatıldı: `crypto.test.ts` aynı vektörü doğruluyor.
const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const argv = process.argv.slice(2);
const bayrak = (ad) => argv.includes(`--${ad}`);
const deger = (ad, varsayilan) => {
  const on = `--${ad}=`;
  const bulunan = argv.find((a) => a.startsWith(on));
  return bulunan ? bulunan.slice(on.length) : varsayilan;
};

const APPLY = bayrak('apply');
const ENV_ADI = deger('env-var', process.env.DB_URL_ENV || 'POSTGRES_URL');
const IZINLI_HOST = deger('allow-host', null);

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
  return { ...harita, ...process.env };
}

const env = envYukle();

// ------------------------------------------------- ZORUNLU: host doğrulaması
function baglantiyiCozVeDogrula() {
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

  for (const digerAd of ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING']) {
    if (digerAd === ENV_ADI || !env[digerAd]) continue;
    let dh = '(çözülemedi)';
    try {
      dh = new URL(env[digerAd]).hostname;
    } catch {
      /* yok say */
    }
    console.log(`    (karşılaştır) ${digerAd} -> ${dh}`);
  }

  const prodGorunumlu = /neon\.tech$/.test(host) || host === IZINLI_HOST;
  const yerel = host === 'localhost' || host === '127.0.0.1';

  if (yerel && IZINLI_HOST !== host) {
    console.error(
      `\n  HATA: ${host} YEREL veritabanı. Prod'a yazmak istiyorsan ` +
        `--env-var=POSTGRES_URL ver; gerçekten yerelde çalışmak istiyorsan ` +
        `--allow-host=${host} ekle.`
    );
    process.exit(2);
  }
  if (!prodGorunumlu) {
    console.error(`\n  HATA: ${host} prod gibi görünmüyor. Emin isen --allow-host=${host} ekle.`);
    process.exit(2);
  }

  console.log(`  Doğrulama             : GEÇTİ`);
  return url;
}

// ------------------------------------------------ ZORUNLU: anahtar doğrulaması
function anahtariCozVeDogrula() {
  console.log('='.repeat(72));
  console.log('ŞİFRELEME ANAHTARI');
  console.log('='.repeat(72));

  const raw = env.ENCRYPTION_KEY;
  if (!raw || raw.trim() === '') {
    console.error('  HATA: ENCRYPTION_KEY tanımlı değil. Üret: openssl rand -base64 32');
    console.error('  Prod için Vercel ortamındaki DEĞERİN AYNISI kullanılmalı.');
    process.exit(3);
  }

  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    console.error(`  HATA: ENCRYPTION_KEY 32 bayt olmalı, ${key.length} bayt çözüldü.`);
    process.exit(3);
  }

  // Anahtarın KENDİSİ değil, parmak izi. Vercel'deki değerle karşılaştırmak için:
  //   vercel env pull && node -e "...aynı hesap..."
  const izi = createHash('sha256').update(key).digest('hex').slice(0, 8);
  console.log(`  Anahtar parmak izi    : ${izi}  (sha256'nın ilk 8 hanesi)`);
  console.log('  ⚠ Bu iz Vercel Production ortamındaki ENCRYPTION_KEY ile AYNI olmalı.');
  console.log('    Farklıysa yazılan kayıtları prod ÇÖZEMEZ.');
  return key;
}

function sifrele(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function coz(key, stored) {
  const payload = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = payload.subarray(IV_BYTES + TAG_BYTES);
  const d = createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

const maskele = (t) => `${t.length} karakter, son 4: …${t.slice(-4)}`;

async function main() {
  const url = baglantiyiCozVeDogrula();
  const key = anahtariCozVeDogrula();

  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const hepsi = await db.client.findMany({
      where: { instagramAccessToken: { not: null } },
      select: { id: true, name: true, instagramAccessToken: true },
      orderBy: { createdAt: 'asc' },
    });

    const duzMetin = hepsi.filter((c) => !c.instagramAccessToken.startsWith(PREFIX));
    const zatenSifreli = hepsi.length - duzMetin.length;

    console.log('='.repeat(72));
    console.log(`RAPOR${APPLY ? '' : '  (DRY-RUN — hiçbir şey yazılmadı)'}`);
    console.log('='.repeat(72));
    console.log(`  Token'ı olan müşteri  : ${hepsi.length}`);
    console.log(`  Zaten şifreli         : ${zatenSifreli}`);
    console.log(`  Şifrelenecek (düz)    : ${duzMetin.length}`);

    if (duzMetin.length === 0) {
      console.log('\n  Yapacak bir şey yok — tüm token\'lar zaten şifreli.');
      return;
    }

    for (const c of duzMetin) {
      console.log(`    - ${c.id} (${c.name}) — ${maskele(c.instagramAccessToken)}`);
    }

    if (!APPLY) {
      console.log('\n  Uygulamak için: node scripts/token-sifrele.mjs --apply');
      return;
    }

    console.log('\n  Yazılıyor…');
    let yazilan = 0;
    for (const c of duzMetin) {
      const orijinal = c.instagramAccessToken;
      const sifreli = sifrele(key, orijinal);

      // Yazmadan ÖNCE kendi çıktımızı çözüp doğrula — yanlış anahtarla
      // okunamaz kayıt üretmenin tek panzehiri bu.
      if (coz(key, sifreli) !== orijinal) {
        console.error(`    ! ${c.id}: şifreleme kendi kendini doğrulayamadı, ATLANDI`);
        continue;
      }

      await db.$transaction(async (tx) => {
        // Koşullu UPDATE: aramayla yazma arasında kayıt değiştiyse (yeniden
        // bağlama, cron yenilemesi) dokunma — yeni değerin üstüne yazmayalım.
        const sonuc = await tx.client.updateMany({
          where: { id: c.id, instagramAccessToken: orijinal },
          data: { instagramAccessToken: sifreli },
        });
        if (sonuc.count !== 1) {
          throw new Error('kayıt bu arada değişmiş — atlandı');
        }
        // Transaction İÇİNDE geri oku ve çöz: yazdığımız şey gerçekten
        // orijinaline dönüyor mu? Dönmüyorsa rollback.
        const geri = await tx.client.findUniqueOrThrow({
          where: { id: c.id },
          select: { instagramAccessToken: true },
        });
        if (coz(key, geri.instagramAccessToken) !== orijinal) {
          throw new Error('geri okuma doğrulaması başarısız');
        }
      });
      yazilan += 1;
      console.log(`    ✓ ${c.id} (${c.name}) şifrelendi ve geri okuma doğrulandı`);
    }

    console.log(`\n  Bitti: ${yazilan}/${duzMetin.length} kayıt şifrelendi.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error('\nBEKLENMEYEN HATA:', error);
  process.exit(1);
});
