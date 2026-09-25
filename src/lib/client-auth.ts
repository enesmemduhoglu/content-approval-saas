import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
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
/**
 * Kaydırmalı oturum (K25): kalan süre bunun altına düşünce çerez yeniden 30
 * güne uzatılır. Her istekte değil yarı ömürde yenileniyor: her yanıta
 * `Set-Cookie` eklemek hiçbir şey kazandırmadan her portal isteğini çerez
 * yazan bir isteğe çevirirdi. "Bırakılan cihaz 30 günde düşer" güvencesi
 * ikisinde de aynı.
 */
export const CLIENT_SESSION_RENEW_BELOW_SECONDS = 15 * 24 * 60 * 60;
/** Kodla girişte token başına hatalı deneme tavanı; dolunca token (link dahil) ölür. */
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
/**
 * Kullanıcı başına son 24 saatteki toplam hatalı kod tavanı. Token başına 5
 * deneme tek başına yetmiyor: saldırgan kurbanın adresine dakikada 3 yeni kod
 * isteyip (login route'unun e-posta sınırı) her birinde 5 deneme yapabilir —
 * günde ~21 bin tahmin, 10⁶ uzayda ~%2 isabet. Bu tavanla günde en fazla 20.
 * Tavan yalnızca KODU kapatır; yeni istenen e-postadaki link çalışmaya devam eder.
 */
export const LOGIN_CODE_DAILY_FAILURE_CAP = 20;

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

/**
 * Kod hash'inin anahtarı — oturum imzasıyla aynı sırdan ama AYRI etiketle
 * türetilir (aynı gerekçe: iki kullanım birbirinin çıktısını geçerli saymasın).
 */
function loginCodeKey(): Buffer | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update("cas-portal-login-code-v1").digest();
}

/**
 * Giriş ekranı iz çerezinin anahtarı (K29) — yine AYRI etiket: iz çerezi
 * oturum çerezinin anahtarıyla imzalansaydı, iki biçimden birinde yapılacak
 * bir hata (ör. yükün yanlış ayrıştırılması) izi oturum yerine geçirebilirdi.
 * Ayrı anahtarla iz, oturum doğrulamasından hiçbir koşulda geçemez.
 */
function traceKey(): Buffer | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update("cas-portal-kimlik-v1").digest();
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * `<önek>.<yük>.<imza>` biçimindeki imzalı değerin yükünü açar; imza, biçim ya
 * da JSON bozuksa `null`. Oturum ve iz çerezi aynı doğrulamadan geçsin diye
 * tek yerde: sabit zamanlı karşılaştırmanın biri için unutulması sessiz olurdu.
 */
function openSigned(value: string, prefix: string, key: Buffer): unknown {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const [, payload, sig] = parts;
  const expected = createHmac("sha256", key).update(`${prefix}.${payload}`).digest();
  const presented = Buffer.from(sig, "base64url");
  // Sabit zamanlı karşılaştırma: imzayı bayt bayt tahmin etmeye yarayan
  // zamanlama farkı bırakma.
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function sealSigned(payload: object, prefix: string, key: Buffer): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", key).update(`${prefix}.${body}`).digest("base64url");
  return `${prefix}.${body}.${sig}`;
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
  const value = sealSigned(
    { u: session.clientUserId, c: session.clientId, exp } satisfies SessionPayload,
    "v1",
    key
  );
  return { value, expiresAt: new Date(exp * 1000) };
}

/** İmza + süre kontrolü. DB'ye bakmaz — kullanıcının hâlâ var olduğunu `getClientSession` doğrular. */
export function verifyClientSession(
  value: string | undefined | null,
  now: Date = new Date()
): ClientSession | null {
  return parseClientSession(value, now)?.session ?? null;
}

/**
 * `verifyClientSession`'ın bitiş zamanını da döndüren hâli. Ayrı fonksiyon
 * çünkü `ClientSession` tipi onlarca çağrı yerinde dolaşıyor; ona `exp`
 * eklemek kaydırmalı oturumla ilgisi olmayan her yeri etkilerdi.
 */
function parseClientSession(
  value: string | undefined | null,
  now: Date
): { session: ClientSession; expiresAt: Date } | null {
  if (!value) return null;
  const key = sessionKey();
  if (!key) return null;
  const parsed = openSigned(value, "v1", key) as SessionPayload | null;
  if (
    typeof parsed?.u !== "string" ||
    typeof parsed?.c !== "string" ||
    typeof parsed?.exp !== "number"
  ) {
    return null;
  }
  if (parsed.exp * 1000 <= now.getTime()) return null;
  return {
    session: { clientUserId: parsed.u, clientId: parsed.c },
    expiresAt: new Date(parsed.exp * 1000),
  };
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
  return (await getClientSessionWithExpiry(request))?.session ?? null;
}

/**
 * `getClientSession` + çerezin bitiş zamanı — kaydırmalı yenilemenin
 * (`/api/portal/session`) ve portal layout'unun "yenileme vakti geldi mi"
 * sorusu için. Doğrulama birebir aynı yoldan geçer.
 */
export async function getClientSessionWithExpiry(
  request?: Request
): Promise<{ session: ClientSession; expiresAt: Date } | null> {
  let raw: string | null | undefined;
  if (request) {
    raw = readCookie(request.headers.get("cookie"), CLIENT_SESSION_COOKIE);
  } else {
    const { cookies } = await import("next/headers");
    raw = (await cookies()).get(CLIENT_SESSION_COOKIE)?.value;
  }
  const parsed = parseClientSession(raw, new Date());
  if (!parsed) return null;
  const user = await db.clientUser.findUnique({
    where: { id: parsed.session.clientUserId },
    select: { clientId: true },
  });
  if (!user || user.clientId !== parsed.session.clientId) return null;
  return parsed;
}

/** Kalan süre yenileme eşiğinin altında mı (K25)? */
export function shouldRenewClientSession(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() - now.getTime() < CLIENT_SESSION_RENEW_BELOW_SECONDS * 1000;
}

/** Yenilemenin vakti: istemciye bu an verilir, eşik sabiti istemci koduna taşınmaz. */
export function clientSessionRenewAt(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() - CLIENT_SESSION_RENEW_BELOW_SECONDS * 1000);
}

/**
 * Oturum çerezini yanıta yazar. Link, kod ve kaydırmalı yenileme bu TEK
 * fonksiyondan geçer: çerez seçenekleri (httpOnly, lax, süre) üç yerde ayrı
 * ayrı yazılsaydı biri bir gün ötekilerden ayrışırdı — ve fark ancak bir
 * cihaz beklenmedik biçimde düştüğünde görülürdü.
 */
export function setClientSessionCookie(
  response: NextResponse,
  session: ClientSession,
  now: Date = new Date()
): { expiresAt: Date } {
  const { value, expiresAt } = signClientSession(session, now);
  response.cookies.set(CLIENT_SESSION_COOKIE, value, sessionCookieOptions(expiresAt));
  // Giriş ekranı kimliği (K29): oturum her kurulduğunda ya da uzadığında iz
  // de tazelenir; böylece "son giriş yapılan sayfa" her zaman güncel oturumun
  // müşterisidir (aynı cihazda başka müşteriye girilirse iz de ona geçer).
  const trace = signPortalTrace(session.clientId, now);
  response.cookies.set(CLIENT_TRACE_COOKIE, trace.value, traceCookieOptions(trace.expiresAt));
  return { expiresAt };
}

// ─── Giriş ekranı kimliği: iz çerezi (K29) ──────────────────────────────────

/**
 * Oturum düştüğünde (30 gün kullanılmadı, çıkış yapıldı, erişim kaldırılıp
 * yeniden verildi) ana ekrandan açılan uygulama giriş ekranına düşer. Oturum
 * yokken hangi müşterinin geldiği bilinmediği için (K23) o ekran nötr
 * "Video Kuyruğu" kimliğini gösteriyordu — kullanıcı kendi uygulamasını açıp
 * başka bir marka görüyordu. İz çerezi bu cihazda en son giriş yapılan
 * müşteriyi hatırlar; giriş ekranı, iOS meta'sı ve manifest onun ADINI ve
 * İKONUNU gösterir.
 *
 * ─── Neden bir yetki DEĞİL ─────────────────────────────────────────────────
 * İz yalnızca `clientId` taşır ve yalnızca `portal-app.ts`'in kimlik
 * çözümünde okunur. Hiçbir portal route'u, `getClientSession` ya da
 * `client-scoped-db` ona bakmaz; izle gelen oturumsuz istek her API'de 401
 * alır. Ayrı anahtar + ayrı önek ("k1") oturum doğrulamasından hiçbir
 * koşulda geçmemesini garanti ediyor.
 *
 * ─── Neden imzalı ──────────────────────────────────────────────────────────
 * Sır değil ama düz `clientId` olsaydı herkes çerezi elle yazıp başka bir
 * müşterinin adını ve ikonunu sunucudan okuyabilirdi. İmza, izi yalnızca
 * başarılı bir girişin üretebileceği bir değere çeviriyor.
 *
 * ─── Neden çıkışta silinmiyor ──────────────────────────────────────────────
 * Amaç tam olarak oturum GİTTİKTEN sonra markayı göstermek. Bu cihaz o
 * müşterinin uygulamasını zaten ana ekranında o ad ve ikonla taşıyor; iz yeni
 * bir bilgi açığa çıkarmıyor. Müşteri silinirse iz çözülemez → varsayılan.
 */
export const CLIENT_TRACE_COOKIE = "cas_portal_kimlik";
/** Bir yıl: telefon uzun süre kullanılmasa da uygulama kendi adıyla açılsın. */
export const CLIENT_TRACE_TTL_SECONDS = 365 * 24 * 60 * 60;

type TracePayload = { c: string; exp: number };

export function signPortalTrace(
  clientId: string,
  now: Date = new Date()
): { value: string; expiresAt: Date } {
  const key = traceKey();
  if (!key) throw new Error("AUTH_SECRET tanımlı değil — portal izi imzalanamaz");
  // `exp` yükte de var: tarayıcının `expires`'ı yalnızca bir rica; kopyalanan
  // bir değerin sunucu tarafında da bir sonu olsun.
  const exp = Math.floor(now.getTime() / 1000) + CLIENT_TRACE_TTL_SECONDS;
  return {
    value: sealSigned({ c: clientId, exp } satisfies TracePayload, "k1", key),
    expiresAt: new Date(exp * 1000),
  };
}

/** İmza + süre kontrolü; DB'ye bakmaz — müşterinin hâlâ var olduğunu çözümleyen doğrular. */
export function verifyPortalTrace(
  value: string | undefined | null,
  now: Date = new Date()
): string | null {
  if (!value) return null;
  const key = traceKey();
  if (!key) return null;
  const parsed = openSigned(value, "k1", key) as TracePayload | null;
  if (typeof parsed?.c !== "string" || !parsed.c || typeof parsed?.exp !== "number") return null;
  if (parsed.exp * 1000 <= now.getTime()) return null;
  return parsed.c;
}

export function traceCookieOptions(expiresAt: Date) {
  return {
    // İstemci kodu izi okumuyor; httpOnly bir XSS'in onu dışarı taşımasını da kapatıyor.
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    // Yalnızca portal sayfaları ve manifest (`/portal...`) okuyor. `/api`
    // altına hiç gitmiyor: iz API isteklerinde görünmesin ki bir gün
    // yanlışlıkla bir yetki kararına karışamasın.
    path: "/portal",
    expires: expiresAt,
  };
}

/** Oturum okuma yoluyla aynı: route handler `request` verir, server component vermez. */
export async function readPortalTraceClientId(request?: Request): Promise<string | null> {
  let raw: string | null | undefined;
  if (request) {
    raw = readCookie(request.headers.get("cookie"), CLIENT_TRACE_COOKIE);
  } else {
    const { cookies } = await import("next/headers");
    raw = (await cookies()).get(CLIENT_TRACE_COOKIE)?.value;
  }
  return verifyPortalTrace(raw);
}

// ─── Magic link ─────────────────────────────────────────────────────────────

export function hashLoginToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * 6 haneli kodun hash'i. Düz SHA-256 YETMEZ: 10⁶ olasılık, sızan bir tablo
 * satırından kodu milisaniyeler içinde geri çıkarırdı. HMAC anahtarı sunucu
 * sırrından geldiği için tablo tek başına işe yaramaz. Satırın `tokenHash`'i
 * girdiye katılıyor ki aynı kod iki satırda farklı hash üretsin.
 */
export function hashLoginCode(tokenHash: string, code: string): string {
  const key = loginCodeKey();
  // Anahtarsız hash herkesin hesaplayabileceği bir değer olurdu — patla.
  if (!key) throw new Error("AUTH_SECRET tanımlı değil — giriş kodu üretilemez");
  return createHmac("sha256", key).update(`${tokenHash}.${code}`).digest("hex");
}

/** `crypto.randomInt` — `Math.random` tahmin edilebilir, kod bir kimlik bilgisi. */
export function generateLoginCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * Yeni giriş token'ı üretir: link token'ı + aynı satıra bağlı 6 haneli kod
 * (V7a — iOS'ta ana ekran uygulamasının çerezleri Safari'den ayrı, e-postadaki
 * link orada oturum açamıyor; kod açabiliyor). DB'ye yalnızca hash'ler yazılır:
 * tablo sızsa bile satırlar giriş linkine ya da koda çevrilemez. Link token'ı
 * 122 bit (`randomUUID`) — onun hash'ine tuz gerekmez.
 */
export async function createLoginToken(
  clientUserId: string,
  now: Date = new Date()
): Promise<{ token: string; code: string }> {
  const token = randomUUID().replace(/-/g, "");
  const code = generateLoginCode();
  const tokenHash = hashLoginToken(token);
  await db.clientLoginToken.create({
    data: {
      clientUserId,
      tokenHash,
      codeHash: hashLoginCode(tokenHash, code),
      expiresAt: new Date(now.getTime() + LOGIN_TOKEN_TTL_MINUTES * 60 * 1000),
    },
  });
  return { token, code };
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
  const { token, code } = await createLoginToken(user.id);
  const mail = await sendPortalLoginEmail({
    to: user.email,
    clientName: user.client.name,
    loginUrl: loginUrl(baseUrl, token),
    code,
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
  // `attempts` koşulu: kodu kaba kuvvetle deneyen biri token'ı kilitlediyse
  // link de ölür (V7-pwa §4.3 "token geçersiz"). Birisi bu hesabın kodunu
  // tahmin etmeye çalışıyor; sahibi yeni link istemekle bir şey kaybetmez.
  const result = await db.clientLoginToken.updateMany({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: { gt: now },
      attempts: { lt: LOGIN_CODE_MAX_ATTEMPTS },
    },
    data: { usedAt: now },
  });
  if (result.count !== 1) return null;
  const row = await db.clientLoginToken.findUnique({
    where: { tokenHash },
    select: { clientUser: { select: { id: true, clientId: true } } },
  });
  if (!row) return null;
  return completeLogin(row.clientUser, now);
}

/** Link ve kod yolunun ortak son adımı: tüketilen token'ın kullanıcısıyla oturum. */
async function completeLogin(
  user: { id: string; clientId: string },
  now: Date
): Promise<ClientSession> {
  await db.clientUser.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  return { clientUserId: user.id, clientId: user.clientId };
}

// ─── Kodla giriş (V7a) ──────────────────────────────────────────────────────

const CODE_PATTERN = /^\d{6}$/;

/**
 * E-postadaki 6 haneli kodu doğrular ve token'ı tüketir. Başarıda oturum,
 * her başarısızlıkta (adres yok, token yok/dolmuş/kilitli, kod yanlış, günlük
 * tavan) AYNI `null` — çağıran nedeni bilmez ki yanıtına da sızdıramasın.
 *
 * Yalnızca kullanıcının EN SON, kullanılmamış, süresi geçmemiş token'ı
 * denenir: eski maillerdeki kodlar ayrı ayrı denenebilseydi her istenen yeni
 * mail tahmin bütçesini katlardı.
 *
 * Kayıtlı/kayıtsız adres ayrımı zamanlamadan da okunmasın diye iki yol aynı
 * sayıda sorgu yapar (bkz. aşağıdaki boş `updateMany`).
 */
export async function consumeLoginCode(
  email: string,
  code: string,
  now: Date = new Date()
): Promise<ClientSession | null> {
  if (!CODE_PATTERN.test(code)) return null;
  const normalized = normalizeEmail(email);
  const [token, failures] = await Promise.all([
    db.clientLoginToken.findFirst({
      where: {
        clientUser: { email: normalized },
        usedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: LOGIN_CODE_MAX_ATTEMPTS },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        tokenHash: true,
        codeHash: true,
        clientUser: { select: { id: true, clientId: true } },
      },
    }),
    db.clientLoginToken.aggregate({
      where: {
        clientUser: { email: normalized },
        createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
      _sum: { attempts: true },
    }),
  ]);

  if (
    !token ||
    !token.codeHash ||
    (failures._sum.attempts ?? 0) >= LOGIN_CODE_DAILY_FAILURE_CAP
  ) {
    // Hiçbir satıra dokunmayan yazma: kayıtsız adres de kayıtlı adres kadar
    // DB gidiş-dönüşü yapsın; zamanlama tek başına "bu adres müşteri" demesin.
    await db.clientLoginToken.updateMany({
      where: { id: "" },
      data: { attempts: { increment: 0 } },
    });
    return null;
  }

  // Sabit zamanlı karşılaştırma: iki hash de 32 bayt, uzunluk da sızmaz.
  const expected = Buffer.from(token.codeHash, "hex");
  const presented = Buffer.from(hashLoginCode(token.tokenHash, code), "hex");
  const match = expected.length === presented.length && timingSafeEqual(expected, presented);

  if (!match) {
    // Koşullu artış: tavanı geçmiş satır bir daha artmaz. Önce-oku-sonra-yaz
    // yapılsaydı paralel denemeler aynı sayacı okuyup tavanı delebilirdi.
    await db.clientLoginToken.updateMany({
      where: { id: token.id, usedAt: null, attempts: { lt: LOGIN_CODE_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    return null;
  }

  // Doğru kod: link akışıyla aynı koşullu tüketim. Arada link kullanıldıysa,
  // süre dolduysa ya da paralel yanlış denemeler kilitlediyse count 0.
  const consumed = await db.clientLoginToken.updateMany({
    where: {
      id: token.id,
      usedAt: null,
      expiresAt: { gt: now },
      attempts: { lt: LOGIN_CODE_MAX_ATTEMPTS },
    },
    data: { usedAt: now },
  });
  if (consumed.count !== 1) return null;
  return completeLogin(token.clientUser, now);
}
