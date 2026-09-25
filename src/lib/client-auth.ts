import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { normalizeEmail } from "@/lib/membership";
import { sendPortalLoginEmail } from "@/lib/email-portal";

/**
 * Video kuyruğu (V3) — müşteri portalının girişi (magic link).
 *
 * ─── Neden NextAuth DEĞİL ───────────────────────────────────────────────────
 * NextAuth bu depoda ajans kimliği için kurulu ve `session.agencyId`
 * sözleşmesi IDOR korumasının zemini (CLAUDE.md). Müşteriyi aynı oturuma
 * sokmak, her `auth()` çağrısının "bu ajans mı müşteri mi" sorusunu sorması
 * demekti — tek bir unutulan kontrol müşteriye ajans paneli açardı. Ayrı
 * çerez, ayrı anahtar, ayrı veri katmanı (`client-scoped-db.ts`): iki kimlik
 * hiçbir noktada birbirinin yerine geçemez.
 *
 * ─── Neden durumsuz (imzalı) çerez ──────────────────────────────────────────
 * Oturum tablosu şemaya yeni bir model demekti. Onun yerine HMAC-imzalı çerez
 * + her istekte `ClientUser` satırının hâlâ var olduğunun kontrolü: ajans
 * erişimi kaldırdığında (satır silinir) çerez bir sonraki istekte ölür. Tek
 * bir cihazdan çıkış çerezi siler; "tüm cihazlardan çık" ancak kullanıcıyı
 * silip yeniden eklemekle olur — bilinen, kabul edilmiş sınır.
 */

export const CLIENT_SESSION_COOKIE = "cas_portal";
/** Magic link ömrü. Kısa: link e-posta kutusunda durduğu sürece bir anahtar. */
export const LOGIN_TOKEN_TTL_MINUTES = 15;
export const CLIENT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export type ClientSession = { clientUserId: string; clientId: string };

// ─── Anahtar ────────────────────────────────────────────────────────────────

/**
 * Çerez imzası AUTH_SECRET'in KENDİSİYLE değil, ondan türetilen ayrı bir
 * anahtarla atılıyor. Aynı sırrı iki farklı protokolde (NextAuth JWT şifrelemesi
 * ve bu HMAC) doğrudan kullanmak, birinin bir gün ötekinin çıktısını geçerli
 * saymasına kapı aralardı; etiketli türetme iki kullanımı kriptografik olarak
 * ayırıyor.
 */
function sessionKey(): Buffer | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update("cas-portal-session-v1").digest();
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

// ─── Çerez ──────────────────────────────────────────────────────────────────

type SessionPayload = { u: string; c: string; exp: number };

export function signClientSession(
  session: ClientSession,
  now: Date = new Date()
): { value: string; expiresAt: Date } {
  const key = sessionKey();
  // Anahtarsız imza atmak "herkesin üretebileceği çerez" demek — sessizce
  // devam etmek yerine yüksek sesle patla.
  if (!key) throw new Error("AUTH_SECRET tanımlı değil — portal oturumu imzalanamaz");
  const exp = Math.floor(now.getTime() / 1000) + CLIENT_SESSION_TTL_SECONDS;
  const payload = b64url(
    JSON.stringify({ u: session.clientUserId, c: session.clientId, exp } satisfies SessionPayload)
  );
  const sig = createHmac("sha256", key).update(`v1.${payload}`).digest("base64url");
  return { value: `v1.${payload}.${sig}`, expiresAt: new Date(exp * 1000) };
}

/** İmza + süre kontrolü. DB'ye bakmaz — kullanıcının hâlâ var olduğunu `getClientSession` doğrular. */
export function verifyClientSession(
  value: string | undefined | null,
  now: Date = new Date()
): ClientSession | null {
  if (!value) return null;
  const key = sessionKey();
  if (!key) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payload, sig] = parts;
  const expected = createHmac("sha256", key).update(`v1.${payload}`).digest();
  const presented = Buffer.from(sig, "base64url");
  // Sabit zamanlı karşılaştırma: imzayı bayt bayt tahmin etmeye yarayan
  // zamanlama farkı bırakma.
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }
  let parsed: SessionPayload;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed?.u !== "string" ||
    typeof parsed?.c !== "string" ||
    typeof parsed?.exp !== "number"
  ) {
    return null;
  }
  if (parsed.exp * 1000 <= now.getTime()) return null;
  return { clientUserId: parsed.u, clientId: parsed.c };
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    // Yerelde http üzerinden çalışabilsin; Vercel'in her dağıtımı production.
    secure: process.env.NODE_ENV === "production",
    // Lax: e-postadaki linkten gelen üst düzey gezinmede çerez gider, cross-site
    // POST'ta gitmez (CSRF'in ilk katmanı; ikincisi `checkOrigin`).
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/**
 * Portal oturumu. Route handler `request` verir (çerez başlıktan okunur —
 * testler de bu yolu kullanıyor); server component vermez, `next/headers`
 * okunur.
 *
 * Her çağrıda `ClientUser` satırı DB'den doğrulanıyor: imza tek başına
 * "bir zamanlar geçerliydi" demek. Ajans erişimi kaldırdığında ya da kullanıcı
 * başka müşteriye taşındığında (clientId değişti) çerez anında geçersizleşmeli.
 */
export async function getClientSession(request?: Request): Promise<ClientSession | null> {
  let raw: string | null | undefined;
  if (request) {
    raw = readCookie(request.headers.get("cookie"), CLIENT_SESSION_COOKIE);
  } else {
    const { cookies } = await import("next/headers");
    raw = (await cookies()).get(CLIENT_SESSION_COOKIE)?.value;
  }
  const session = verifyClientSession(raw);
  if (!session) return null;
  const user = await db.clientUser.findUnique({
    where: { id: session.clientUserId },
    select: { clientId: true },
  });
  if (!user || user.clientId !== session.clientId) return null;
  return session;
}

// ─── Magic link ─────────────────────────────────────────────────────────────

export function hashLoginToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Yeni giriş token'ı üretir. DB'ye yalnızca SHA-256 hash'i yazılır: tablo
 * sızsa bile içindeki satırlar giriş linkine çevrilemez. Token 122 bit
 * (`randomUUID`) — hash'e tuz gerekmez, sözlük saldırısının konusu değil.
 */
export async function createLoginToken(
  clientUserId: string,
  now: Date = new Date()
): Promise<string> {
  const token = randomUUID().replace(/-/g, "");
  await db.clientLoginToken.create({
    data: {
      clientUserId,
      tokenHash: hashLoginToken(token),
      expiresAt: new Date(now.getTime() + LOGIN_TOKEN_TTL_MINUTES * 60 * 1000),
    },
  });
  return token;
}

export function loginUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/portal/giris/dogrula?token=${encodeURIComponent(token)}`;
}

/**
 * Giriş linki isteği. Dönüş değeri YOK, bilinçli: çağıran (login route'u)
 * e-postanın kayıtlı olup olmadığını bilmemeli ki yanıtına da sızdıramasın.
 * Sonuç yalnızca log'a düşer (adres değil, kullanıcı id'si).
 */
export async function requestLoginLink(email: string, baseUrl: string): Promise<void> {
  const user = await db.clientUser.findUnique({
    where: { email: normalizeEmail(email) },
    include: { client: { select: { name: true } } },
  });
  if (!user) return;
  await issueLoginLink(user, baseUrl, false);
}

/** Token üretip maili yollar; ajansın "erişim aç" yolu da bunu kullanıyor. */
export async function issueLoginLink(
  user: { id: string; email: string; client: { name: string } },
  baseUrl: string,
  invited: boolean
): Promise<{ sent: boolean }> {
  const token = await createLoginToken(user.id);
  const mail = await sendPortalLoginEmail({
    to: user.email,
    clientName: user.client.name,
    loginUrl: loginUrl(baseUrl, token),
    ttlMinutes: LOGIN_TOKEN_TTL_MINUTES,
    invited,
  });
  if (!mail.sent) {
    console.error(`[client-auth] giriş maili gönderilemedi (kullanıcı=${user.id}): ${mail.reason}`);
  }
  return { sent: mail.sent };
}

/**
 * Token'ı tüketir. Tek kullanım koşullu UPDATE ile (`usedAt: null`): aynı link
 * iki sekmede aynı anda açılsa bile yalnızca biri oturum alır — önce-oku-
 * sonra-yaz yapılsaydı ikisi de geçerdi (CLAUDE.md yarış koruması).
 */
export async function consumeLoginToken(
  token: string,
  now: Date = new Date()
): Promise<ClientSession | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = hashLoginToken(token);
  const result = await db.clientLoginToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (result.count !== 1) return null;
  const row = await db.clientLoginToken.findUnique({
    where: { tokenHash },
    select: { clientUser: { select: { id: true, clientId: true } } },
  });
  if (!row) return null;
  await db.clientUser.update({
    where: { id: row.clientUser.id },
    data: { lastLoginAt: now },
  });
  return { clientUserId: row.clientUser.id, clientId: row.clientUser.clientId };
}
