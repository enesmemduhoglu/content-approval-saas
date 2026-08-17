import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Veritabanında duran üçüncü taraf sırlarının şifrelenmesi (S1).
 *
 * Şu an tek kullanıcısı `Client.instagramAccessToken`. O token bir UYGULAMA
 * SIRRI DEĞİL — müşterinin Instagram hesabına yayın yapma yetkisidir. Düz metin
 * durduğu sürece bir Neon dump'ı, bir yedek, yanlış yapılandırılmış bir
 * read-replica ya da Prisma query logging'in açılması doğrudan hesap ele
 * geçirmeye çıkıyordu ve bedelini biz değil müşteri öderdi.
 *
 * ─── Biçim ──────────────────────────────────────────────────────────────────
 *   enc:v1:<base64( iv(12) ‖ authTag(16) ‖ ciphertext )>
 *
 * AES-256-GCM: şifrelemenin yanında BÜTÜNLÜK de doğrular — kurcalanmış bir
 * değer sessizce yanlış token üretmez, `decrypt` patlar.
 *
 * ─── Geçiş (kesintisiz) ─────────────────────────────────────────────────────
 * `enc:v1:` öneki OLMAYAN değer düz metin kabul edilip olduğu gibi döner. Yani
 * bu kod devreye girdiğinde mevcut kayıtlar çalışmaya devam eder; her yazmada
 * (yeniden bağlama, cron yenilemesi) şifreliye dönerler. Prod'daki kalıntıyı
 * beklemeden çevirmek için `scripts/token-sifrele.mjs` var.
 *
 * ─── Anahtar yoksa ne olur ──────────────────────────────────────────────────
 * Production'da ŞİFRELEME ZORUNLU: anahtar yoksa yazma patlar. Sessizce düz
 * metin yazmak, "şifreleme var" sanılan ama olmayan bir sistem üretirdi —
 * bu depodaki en pahalı hata sınıfı tam olarak bu (bkz. #31, sessizce kaybolan
 * mailler). Geliştirmede ise düz metne düşer ve yüksek sesle uyarır; yerel
 * kurulumun dış servis olmadan çalışması kuralı korunur (bkz. README).
 *
 * ─── Bilinçli olarak YAPILMAYAN ─────────────────────────────────────────────
 * AAD ile şifreli metni `Client.id`'ye bağlamak (bir token'ın satırdan satıra
 * taşınmasını engellerdi) yapılmadı: bunu yapabilen saldırgan zaten DB'ye yazma
 * yetkisine sahiptir ve elinde çok daha kolay yollar vardır. Karşılığında
 * migration betiği ve her çağrı yeri id taşımak zorunda kalırdı.
 */

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Şifreleme/çözme başarısız — ASLA sessizce yutulmaz, çağıran karar verir. */
export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretCryptoError";
  }
}

/**
 * `ENCRYPTION_KEY` — base64 kodlanmış 32 bayt.
 * Üret: `openssl rand -base64 32`
 *
 * Yanlış uzunluktaki anahtar "yok" sayılmaz, HATA sayılır: yarı yapılandırılmış
 * bir anahtarla düz metne düşmek, sorunu gizlemenin en sinsi yolu olurdu.
 */
function readKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") return null;

  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      `ENCRYPTION_KEY base64 çözüldüğünde ${KEY_BYTES} bayt olmalı, ` +
        `${key.length} bayt geldi. Üret: openssl rand -base64 32`
    );
  }
  return key;
}

/** Bir değer bu modülün ürettiği şifreli biçimde mi? */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Şifreleme yapılandırılmış mı — betikler ve teşhis için. */
export function encryptionConfigured(): boolean {
  return readKey() !== null;
}

/**
 * Sırrı şifreler. Anahtar yoksa: production'da HATA, geliştirmede düz metin +
 * yüksek sesle uyarı.
 */
export function encryptSecret(plaintext: string): string {
  const key = readKey();

  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new SecretCryptoError(
        "ENCRYPTION_KEY tanımlı değil — sır düz metin yazılmayacak. " +
          "Vercel ortamına ekle: openssl rand -base64 32"
      );
    }
    console.error(
      "[crypto] ENCRYPTION_KEY yok — sır DÜZ METİN yazılıyor. " +
        "Yalnızca yerel geliştirmede kabul edilebilir."
    );
    return plaintext;
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/**
 * Sırrı çözer. Önek yoksa düz metin kabul edilip olduğu gibi döner (geçiş yolu).
 *
 * Önek VARSA ve çözülemiyorsa `SecretCryptoError` fırlatır — anahtar
 * kaybolduğunda ya da veri kurcalandığında çağıran tarafın şifreli metni token
 * sanıp Instagram'a göndermesi, teşhisi imkânsız bir hataya dönerdi.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;

  const key = readKey();
  if (!key) {
    throw new SecretCryptoError(
      "Kayıt şifreli ama ENCRYPTION_KEY tanımlı değil — çözülemiyor."
    );
  }

  let payload: Buffer;
  try {
    payload = Buffer.from(stored.slice(PREFIX.length), "base64");
  } catch {
    throw new SecretCryptoError("Şifreli değer base64 olarak çözülemedi.");
  }
  if (payload.length <= IV_BYTES + TAG_BYTES) {
    throw new SecretCryptoError("Şifreli değer eksik ya da bozuk.");
  }

  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Ayrıntı bilerek taşınmıyor: mesaj log'a ve hata yollarına düşebiliyor.
    throw new SecretCryptoError(
      "Şifreli değer çözülemedi — anahtar yanlış ya da veri bozulmuş olabilir."
    );
  }
}

/**
 * Çözmeyi dener, başarısızlıkta `null` döner.
 *
 * Yalnızca sırrın KENDİSİNE ihtiyaç duyulmayan yerler için: paneldeki "son 4
 * karakter" ipucu gibi. Orada bir çözme hatası yüzünden sayfayı komple
 * düşürmek, kozmetik bir alan uğruna ajansın panelini kapatmak olurdu.
 * Token'ın kullanılacağı yerlerde bu DEĞİL, `decryptSecret` kullanılır.
 */
export function tryDecryptSecret(stored: string): string | null {
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}
