/**
 * caption-stili-yukle.mjs
 * ------------------------------------------------------------------
 * NE YAPAR
 * `docs/video-kuyrugu/caption-stili.md` dosyasının "## Talimat" bölümünü bir
 * müşterinin `Client.captionStyle` alanına yazar. Video kuyruğunda caption
 * üretimi bu alanı sistem talimatı olarak kullanıyor (K6); alan boşsa genel
 * bir talimata düşülür ve sayfanın üslubu kaybolur.
 *
 * NEDEN BETİK, NEDEN ARAYÜZ DEĞİL
 * Stil belgesi repoda sürümleniyor ve kaynağı orası (caption-stili.md: "önce
 * burası güncellenir, sonra alan"). Panelden elle düzenlenebilen bir alan iki
 * gerçeğin ayrışmasına yol açardı. İkinci bir müşteri geldiğinde ya bu betik
 * başka bir belgeyle çalıştırılır ya da o zaman arayüz kararı verilir.
 *
 * ⚠️ BAĞLANTI TUZAĞI — bkz. bos-ajans-temizligi.mjs
 * `.env.local`: DATABASE_URL yerel (localhost:5455), POSTGRES_URL prod Neon.
 * Betik HİÇBİR sorgudan önce hostu yazdırır; `*.neon.tech` değilse ya da
 * `--allow-host` ile açıkça izin verilmediyse sorgu açmadan çıkar.
 *
 * KULLANIM
 *   node scripts/caption-stili-yukle.mjs --client=<clientId>            # kuru koşu
 *   node scripts/caption-stili-yukle.mjs --client=<clientId> --apply    # yaz
 *   [--env-var=POSTGRES_URL] [--allow-host=localhost] [--belge=<yol>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const bayrak = (ad) => argv.includes(`--${ad}`);
const deger = (ad, varsayilan) => {
  const on = `--${ad}=`;
  const bulunan = argv.find((a) => a.startsWith(on));
  return bulunan ? bulunan.slice(on.length) : varsayilan;
};

const APPLY = bayrak('apply');
const CLIENT_ID = deger('client', null);
const ENV_ADI = deger('env-var', 'POSTGRES_URL');
const IZINLI_HOST = deger('allow-host', null);
const BELGE = path.resolve(KOK, deger('belge', 'docs/video-kuyrugu/caption-stili.md'));

if (!CLIENT_ID) {
  console.error('--client=<clientId> zorunlu');
  process.exit(1);
}

// .env.local'i elle oku: dotenv bağımlılığı yok ve betik yalnızca tek bir
// değişkene ihtiyaç duyuyor.
function envOku(ad) {
  if (process.env[ad]) return process.env[ad];
  for (const dosya of ['.env.local', '.env']) {
    const yol = path.join(KOK, dosya);
    if (!fs.existsSync(yol)) continue;
    for (const satir of fs.readFileSync(yol, 'utf8').split(/\r?\n/)) {
      const m = satir.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] === ad) return m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

// "## Talimat" başlığından bir sonraki "## " başlığına kadar. Başlığın kendisi
// alana girmez; alt başlıklar (###) ve kalın etiketler olduğu gibi kalır.
function talimatiCikar(metin) {
  const satirlar = metin.split(/\r?\n/);
  const bas = satirlar.findIndex((s) => /^##\s+Talimat\b/.test(s));
  if (bas === -1) throw new Error('"## Talimat" bölümü bulunamadı');
  let son = satirlar.findIndex((s, i) => i > bas && /^##\s+/.test(s));
  if (son === -1) son = satirlar.length;
  return satirlar.slice(bas + 1, son).join('\n').trim();
}

const url = envOku(ENV_ADI);
if (!url) {
  console.error(`${ENV_ADI} bulunamadı`);
  process.exit(2);
}
const host = new URL(url).hostname;
console.log(`Bağlanılacak host: ${host} (${ENV_ADI})`);
const prodMu = host.endsWith('.neon.tech');
if (!prodMu && host !== IZINLI_HOST) {
  console.error('Host prod (*.neon.tech) değil ve --allow-host ile izin verilmedi — çıkılıyor.');
  process.exit(2);
}

const talimat = talimatiCikar(fs.readFileSync(BELGE, 'utf8'));
console.log(`Talimat: ${talimat.length} karakter (${path.relative(KOK, BELGE)})`);

const db = new PrismaClient({ datasources: { db: { url } } });
try {
  const client = await db.client.findUnique({
    where: { id: CLIENT_ID },
    select: { id: true, name: true, captionStyle: true },
  });
  if (!client) {
    console.error(`Müşteri bulunamadı: ${CLIENT_ID}`);
    process.exit(3);
  }
  const mevcut = client.captionStyle ?? '';
  console.log(`Müşteri: ${client.name} (${client.id})`);
  console.log(`Mevcut alan: ${mevcut ? `${mevcut.length} karakter` : 'boş'}`);
  if (mevcut === talimat) {
    console.log('Alan zaten güncel — yazılacak bir şey yok.');
  } else if (!APPLY) {
    console.log('Kuru koşu: yazmak için --apply ekle.');
  } else {
    // Önce-oku-sonra-yaz burada bilinçli: alan bir karar değil (onay/yayın
    // gibi yarışan iki yol yok), onu yazan tek yer bu betik; okuma yalnızca
    // kuru koşunun farkı gösterebilmesi için.
    await db.client.update({ where: { id: client.id }, data: { captionStyle: talimat } });
    console.log('Yazıldı.');
  }
} finally {
  await db.$disconnect();
}
