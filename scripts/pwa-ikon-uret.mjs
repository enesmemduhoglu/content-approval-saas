#!/usr/bin/env node
// Tek bir kare kaynak görselden PWA ikon setini üretir.
//
// Kullanım:
//   node scripts/pwa-ikon-uret.mjs <kaynak.png> <çıktı-klasörü> [--zemin=#0E2038]
//                                  [--zemini-boya] [--maskable-olcek=0.8]
//
// Çıktılar:
//   kaynak-1024.png   1024x1024, opak (ileride yeniden üretim için referans)
//   icon-180.png      apple-touch-icon — iOS köşeleri kendisi yuvarlar ve şeffaf
//                     pikselleri siyaha boyar, bu yüzden düz zemin üzerine basılır
//   icon-192.png      manifest "any"
//   icon-512.png      manifest "any"
//   maskable-512.png  manifest "maskable" — Android ikonu daire/damla vb. maskeyle
//                     kırpar; yalnızca merkezdeki %80 çaplı daire garanti görünür.
//                     İçerik --maskable-olcek oranında küçültülüp zemin rengiyle
//                     çevrelenir. Kaynağın içeriği zaten o dairenin içindeyse
//                     --maskable-olcek=1 verilebilir.
//
// --zemini-boya: kaynağın dört köşesinden başlayıp köşe rengine yakın (bağlantılı)
// pikselleri --zemin rengine boyar. Üretken modeller marka rengini birebir
// tutturamadığı için zemin, manifest background_color/theme_color ile aynı olsun
// diye kullanılır (splash ekranında ikonla zemin arasında ek yeri görünmesin).

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

function kullanim(mesaj) {
  if (mesaj) console.error(`Hata: ${mesaj}`);
  console.error(
    "Kullanım: node scripts/pwa-ikon-uret.mjs <kaynak.png> <çıktı-klasörü> " +
      "[--zemin=#0E2038] [--zemini-boya] [--maskable-olcek=0.8]",
  );
  process.exit(1);
}

const argumanlar = process.argv.slice(2);
const konumsal = argumanlar.filter((a) => !a.startsWith("--"));
const secenek = (ad) => {
  const a = argumanlar.find((x) => x === `--${ad}` || x.startsWith(`--${ad}=`));
  if (!a) return undefined;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : true;
};

if (konumsal.length !== 2) kullanim();
const [kaynakYolu, ciktiKlasoru] = konumsal.map((p) => resolve(p));

const zeminHex = String(secenek("zemin") ?? "#0E2038");
const hexEslesme = /^#?([0-9a-f]{6})$/i.exec(zeminHex);
if (!hexEslesme) kullanim(`geçersiz zemin rengi: ${zeminHex}`);
const zemin = {
  r: parseInt(hexEslesme[1].slice(0, 2), 16),
  g: parseInt(hexEslesme[1].slice(2, 4), 16),
  b: parseInt(hexEslesme[1].slice(4, 6), 16),
};

const maskableOlcek = Number(secenek("maskable-olcek") ?? 0.8);
if (!(maskableOlcek > 0 && maskableOlcek <= 1)) kullanim("--maskable-olcek 0 ile 1 arasında olmalı");

const BOYUT = 1024;
// Köşe rengine bu Öklid uzaklığından yakın bağlantılı pikseller zemin sayılır.
const ZEMIN_TOLERANS = 10;

// Zemini bağlantılı bölge doldurma (flood fill) ile boyar; figürün içindeki
// benzer renkli alanlara (ör. koyu tişört) sızmaz, çünkü yalnızca köşelerden
// ulaşılabilen ve köşe rengine yakın pikseller değişir.
function zeminiBoya(veri, genislik, yukseklik, kanal) {
  const i = (x, y) => (y * genislik + x) * kanal;
  const koseler = [
    [0, 0],
    [genislik - 1, 0],
    [0, yukseklik - 1],
    [genislik - 1, yukseklik - 1],
  ];
  const ref = [0, 1, 2].map(
    (c) => koseler.reduce((t, [x, y]) => t + veri[i(x, y) + c], 0) / koseler.length,
  );
  const yakin = (p) =>
    Math.hypot(veri[p] - ref[0], veri[p + 1] - ref[1], veri[p + 2] - ref[2]) <= ZEMIN_TOLERANS;

  const gorulen = new Uint8Array(genislik * yukseklik);
  const yigin = [];
  for (const [x, y] of koseler) yigin.push(x, y);
  let boyanan = 0;
  while (yigin.length) {
    const y = yigin.pop();
    const x = yigin.pop();
    if (x < 0 || y < 0 || x >= genislik || y >= yukseklik) continue;
    const n = y * genislik + x;
    if (gorulen[n]) continue;
    gorulen[n] = 1;
    const p = n * kanal;
    if (!yakin(p)) continue;
    veri[p] = zemin.r;
    veri[p + 1] = zemin.g;
    veri[p + 2] = zemin.b;
    boyanan++;
    yigin.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  return { boyanan, ref: ref.map((v) => Math.round(v)) };
}

const meta = await sharp(kaynakYolu).metadata();
if (meta.width !== meta.height) {
  console.warn(`Uyarı: kaynak kare değil (${meta.width}x${meta.height}); ortadan kırpılacak.`);
}

// Kaynağı 1024 kare, opak RGB'ye getir (şeffaflık varsa zemin rengine oturt).
let { data, info } = await sharp(kaynakYolu)
  .resize(BOYUT, BOYUT, { fit: "cover" })
  .flatten({ background: zemin })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

if (secenek("zemini-boya")) {
  const { boyanan, ref } = zeminiBoya(data, info.width, info.height, info.channels);
  const oran = ((boyanan / (info.width * info.height)) * 100).toFixed(1);
  console.log(`Zemin boyandı: köşe rengi rgb(${ref.join(",")}) -> ${zeminHex}, piksellerin %${oran}'i`);
}

const kaynak = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
  .png()
  .toBuffer();
const kaynakPng = await kaynak;

mkdirSync(ciktiKlasoru, { recursive: true });

const yaz = async (ad, islem) => {
  const hedef = join(ciktiKlasoru, ad);
  await islem.png({ compressionLevel: 9 }).toFile(hedef);
  console.log(`yazıldı: ${hedef}`);
};

await yaz("kaynak-1024.png", sharp(kaynakPng));
for (const boyut of [180, 192, 512]) {
  await yaz(
    `icon-${boyut}.png`,
    sharp(kaynakPng).resize(boyut, boyut, { kernel: "lanczos3" }).flatten({ background: zemin }),
  );
}

const MASKABLE = 512;
const ic = Math.round(MASKABLE * maskableOlcek);
const icBuf = await sharp(kaynakPng).resize(ic, ic, { kernel: "lanczos3" }).png().toBuffer();
const kenar = Math.floor((MASKABLE - ic) / 2);
await yaz(
  "maskable-512.png",
  sharp(
    await sharp({ create: { width: MASKABLE, height: MASKABLE, channels: 3, background: zemin } })
      .composite([{ input: icBuf, left: kenar, top: kenar }])
      .png()
      .toBuffer(),
  ).removeAlpha(),
);
