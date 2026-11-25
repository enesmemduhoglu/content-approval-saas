/**
 * ig-gorsel-dogrula.mjs
 * ------------------------------------------------------------------
 * NE YAPAR
 * V12 (K36) reklam görselinin canlıya açılmadan önceki tek açık sorusu:
 * Instagram, gizli R2 bucket'ındaki bir GÖRSELİ süreli imzalı URL'den
 * çekip container kurabiliyor mu? Video için V1'de doğrulandı (K20); görsel
 * `image_url` ayrı bir indirme yolu ve hiç denenmedi. Yayın anında
 * öğrenmek, reklamın `failed`a düşmesi demek.
 *
 * Adımlar (yalnızca --calistir ile):
 *   1. Token'ı prod'dan furi'nin yoluyla alır: `GET <FURI_SAAS_URL>/api/clients/
 *      <FURI_CLIENT_ID>/instagram-token` (Bearer FURI_API_KEY, `furi1/.env`).
 *      Yerelde `ENCRYPTION_KEY` yok; DB'deki şifreli token'ı çözmeye çalışmaz.
 *   2. Görseli R2'ye geçici anahtarla koyar: `clients/<id>/ads/_ig-dogrulama-<zaman>.jpg`.
 *   3. 1 saatlik imzalı GET URL'i üretir (yayın yolu 7 gün imzalıyor; burada
 *      kısa yeter, Instagram indirmeyi container kurarken yapıyor).
 *   4. `POST /{ig-user-id}/media` (image_url) ile container açar ve
 *      `status_code` FINISHED olana kadar yoklar.
 *   5. R2'deki geçici nesneyi siler (hata olsa da).
 *
 * YAYIN YAPMAZ: `media_publish` hiç çağrılmaz. Yayınlanmamış container
 * Instagram'da 24 saatte kendiliğinden düşer, profilde hiçbir şey görünmez.
 *
 * Token, imzalı URL ve anahtarlar hiçbir koşulda ekrana basılmaz
 * (IGError.report / safeDetail kalıbı): Instagram hata gövdesindeki URL'ler
 * maskelenir.
 *
 * BAĞLANTI: R2 anahtarları `.env.local`'den, furi anahtarları `../furi1/.env`'den.
 * DB'ye BAĞLANMAZ.
 *
 * KULLANIM
 *   node scripts/ig-gorsel-dogrula.mjs                       # kuru: yapılandırma + görsel kontrolü
 *   node scripts/ig-gorsel-dogrula.mjs --calistir            # gerçekten dener (R2 + Instagram, yayınsız)
 *   node scripts/ig-gorsel-dogrula.mjs --gorsel=<yol.jpg>    # başka görselle
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const bayrak = (ad) => argv.find((a) => a.startsWith(`--${ad}=`))?.slice(ad.length + 3);
const CALISTIR = argv.includes('--calistir');
const GORSEL = path.resolve(
  bayrak('gorsel') ?? path.join(KOK, '..', 'furi1', '_reklam', 'ozel-ders', 'seri', '01.jpg')
);
const IG_VERSION = 'v23.0'; // src/lib/instagram.ts DEFAULT_VERSION ile aynı
const MAX_AD_BYTES = 8 * 1024 * 1024; // portal-validation.ts ile aynı
const BEKLEME_MS = 90_000;

function envOku(dosya) {
  if (!fs.existsSync(dosya)) throw new Error(`${dosya} bulunamadı`);
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

/** Ekrana basılan her metinden sır taşıyabilecek parçaları ayıklar. */
function maskele(metin) {
  return String(metin)
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/access_token=[^&\s"]+/g, 'access_token=<gizli>')
    .replace(/X-Amz-[A-Za-z-]+=[^&\s"]+/g, '<imza>')
    .slice(0, 400);
}

/** jpeg-size.ts'in eşi: SOF başlığından en/boy (betik TS import edemiyor). */
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

async function graph(yol, parametreler, token, method) {
  const ara = new URLSearchParams({ ...parametreler, access_token: token });
  const url = `https://graph.instagram.com/${IG_VERSION}/${yol}`;
  const res = await fetch(method === 'GET' ? `${url}?${ara}` : url, {
    method,
    body: method === 'POST' ? ara : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const govde = await res.json().catch(() => ({}));
  if (!res.ok || govde.error) {
    const e = govde.error ?? {};
    throw new Error(
      `Instagram ${method} ${yol.split('/').pop()} → HTTP ${res.status}` +
        (e.code ? ` code=${e.code}` : '') +
        (e.error_subcode ? ` subcode=${e.error_subcode}` : '') +
        (e.message ? ` · ${maskele(e.message)}` : '')
    );
  }
  return govde;
}

// ─── 0. Yapılandırma (kuru modda da) ────────────────────────────────────────

const yerel = envOku(path.join(KOK, '.env.local'));
const furi = envOku(path.join(KOK, '..', 'furi1', '.env'));
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
  if (!yerel[k]) throw new Error(`.env.local içinde ${k} yok`);
}
for (const k of ['FURI_SAAS_URL', 'FURI_API_KEY', 'FURI_CLIENT_ID']) {
  if (!furi[k]) throw new Error(`furi1/.env içinde ${k} yok`);
}
const saas = furi.FURI_SAAS_URL.replace(/\/+$/, '');
console.log(`SaaS: ${new URL(saas).host} · müşteri: ${furi.FURI_CLIENT_ID} · R2 bucket: ${yerel.R2_BUCKET}`);

const bayt = fs.readFileSync(GORSEL);
const boyut = jpegBoyutu(bayt);
console.log(`Görsel: ${path.basename(GORSEL)} · ${(bayt.length / 1024).toFixed(0)} KB · ${boyut ? `${boyut.en}×${boyut.boy}` : 'JPEG değil'}`);
if (!boyut) throw new Error('Görsel JPEG değil — Instagram image_url yalnızca JPEG kabul ediyor');
if (bayt.length > MAX_AD_BYTES) throw new Error('Görsel 8 MB üstü');
const oran = boyut.en / boyut.boy;
if (oran < 0.799 || oran > 1.911) throw new Error(`Oran Instagram dışı (${oran.toFixed(3)})`);

if (!CALISTIR) {
  console.log('\nKURU ÇALIŞMA — hiçbir şey gönderilmedi. Denemek için: --calistir');
  console.log('Yapılacaklar: token (prod uç) → R2 geçici PUT → imzalı URL → IG container (YAYINSIZ) → R2 sil');
  process.exit(0);
}

// ─── 1. Token ──────────────────────────────────────────────────────────────

const tokRes = await fetch(`${saas}/api/clients/${encodeURIComponent(furi.FURI_CLIENT_ID)}/instagram-token`, {
  headers: { Authorization: `Bearer ${furi.FURI_API_KEY}` },
  signal: AbortSignal.timeout(30_000),
});
const tok = await tokRes.json().catch(() => ({}));
if (!tokRes.ok || !tok.accessToken || !tok.instagramUserId) {
  throw new Error(`Token alınamadı: HTTP ${tokRes.status} ${maskele(tok.error ?? '')}`);
}
if (tok.expired) throw new Error('Instagram token süresi dolmuş — önce panelden yenilenmeli');
console.log(`1/4 Token alındı (bitiş: ${tok.expiresAt ?? 'bilinmiyor'})`);

// ─── 2. R2 geçici nesne ────────────────────────────────────────────────────

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${yerel.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: yerel.R2_ACCESS_KEY_ID, secretAccessKey: yerel.R2_SECRET_ACCESS_KEY },
});
// Müşteri öneki ŞART: üretim kodu yalnızca bu önekteki anahtarı imzalıyor;
// doğrulama aynı yerden olsun ki "başka önekte çalıştı" yanılgısı doğmasın.
const anahtar = `clients/${tok.clientId}/ads/_ig-dogrulama-${Date.now()}.jpg`;

let sonuc = 1;
try {
  await r2.send(
    new PutObjectCommand({ Bucket: yerel.R2_BUCKET, Key: anahtar, Body: bayt, ContentType: 'image/jpeg' })
  );
  const imzali = await getSignedUrl(r2, new GetObjectCommand({ Bucket: yerel.R2_BUCKET, Key: anahtar }), {
    expiresIn: 3600,
  });
  console.log(`2/4 R2'ye kondu, imzalı URL üretildi (1 saat)`);

  // ─── 3. Container (yayınsız) ─────────────────────────────────────────────
  const baslangic = Date.now();
  const kap = await graph(
    `${tok.instagramUserId}/media`,
    { image_url: imzali, caption: 'Doğrulama — yayınlanmayacak' },
    tok.accessToken,
    'POST'
  );
  console.log(`3/4 Container açıldı (${((Date.now() - baslangic) / 1000).toFixed(1)} sn): ${kap.id}`);

  // ─── 4. Durum ────────────────────────────────────────────────────────────
  let durum = 'UNKNOWN';
  let detay = '';
  while (Date.now() - baslangic < BEKLEME_MS) {
    const g = await graph(String(kap.id), { fields: 'status_code,status' }, tok.accessToken, 'GET');
    durum = String(g.status_code ?? 'UNKNOWN');
    detay = g.status ? maskele(g.status) : '';
    if (durum === 'FINISHED' || durum === 'ERROR' || durum === 'EXPIRED') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`4/4 Container durumu: ${durum}${detay ? ` · ${detay}` : ''}`);

  if (durum === 'FINISHED') {
    console.log('\n✓ BAŞARILI: Instagram R2 imzalı URL\'den görsel container kurabiliyor. Reklam canlıya açılabilir.');
    console.log('  (media_publish çağrılmadı; container 24 saatte kendiliğinden düşer.)');
    sonuc = 0;
  } else {
    console.log('\n✗ BAŞARISIZ: görsel container hazır olmadı. Reklamı AÇMA; çıktıyı Claude\'a ilet.');
  }
} catch (error) {
  console.error(`\n✗ HATA: ${maskele(error.message)}`);
} finally {
  await r2
    .send(new DeleteObjectCommand({ Bucket: yerel.R2_BUCKET, Key: anahtar }))
    .then(() => console.log('R2 geçici nesnesi silindi.'))
    .catch((e) => console.error(`R2 geçici nesnesi SİLİNEMEDİ (${anahtar}): ${maskele(e.message)}`));
}
process.exit(sonuc);
