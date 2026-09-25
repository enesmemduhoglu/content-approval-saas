import { NextResponse } from "next/server";
import { consumeLoginCode, setClientSessionCookie } from "@/lib/client-auth";
import { normalizeEmail } from "@/lib/membership";
import { checkOrigin } from "@/lib/origin";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { validateClientEmail } from "@/lib/validation";

/**
 * V7a — e-postadaki 6 haneli kodla giriş.
 *
 * Neden var: iOS'ta ana ekrana eklenmiş uygulamanın çerez deposu Safari'den
 * AYRI. E-postadaki link Safari'de açılır ve oturum Safari'de kalır; uygulama
 * yine giriş ekranında durur. Kod ise uygulamanın içinde yazılır, çerez
 * uygulamanın deposuna düşer (K23).
 *
 * Kontrol sırası giriş linki route'uyla aynı (`../route.ts`): oturum adımı
 * yok (bu route oturumu başlatıyor) → `checkOrigin` → IP sınırı → gövde →
 * e-posta sınırı → iş. Çerezsiz bir route'ta `checkOrigin` yine de anlamlı:
 * başka bir sitenin kurbanın tarayıcısına saldırganın hesabıyla oturum
 * açtırmasını (login CSRF) keser.
 *
 * ─── Kaba kuvvet ────────────────────────────────────────────────────────────
 * 10⁶ olasılık; üç katman:
 *  • token başına 5 hatalı deneme → token (link dahil) ölür,
 *  • kullanıcı başına 24 saatte 20 hatalı deneme → kod yolu kapanır,
 *  • IP ve e-posta başına dakikalık `checkRateLimit`.
 * İlk ikisi DB'de (`consumeLoginCode`) çünkü in-memory sınır serverless
 * instance'lar arasında paylaşılmıyor; asıl güvence sayaçta olmalı.
 *
 * ─── E-posta sızdırmama ────────────────────────────────────────────────────
 * Adres kayıtsız, token yok, süresi dolmuş, kilitli, kod yanlış: hepsi AYNI
 * yanıt. Farklı yanıt, adresin kayıtlı olup olmadığını söylerdi.
 */
const LOGIN_CODE_EMAIL_RATE_MAX = 5;

const INVALID_CODE = {
  error: "Kod hatalı ya da süresi dolmuş. En son gelen e-postadaki kodu gir ya da yeni kod iste.",
  field: "code",
};

export async function POST(request: Request) {
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  const ip = getClientIp(request.headers);
  if (await checkRateLimit(`portal-code-ip:${ip}`)) {
    return NextResponse.json(
      { error: "Çok fazla deneme, biraz sonra tekrar deneyin" },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
  }
  const { email, code } = (body ?? {}) as { email?: unknown; code?: unknown };
  const emailError = validateClientEmail(email);
  if (emailError) {
    return NextResponse.json({ error: emailError, field: "email" }, { status: 400 });
  }
  // Boşluklar tolere ediliyor: e-postadan kopyalanan "123 456" de geçsin.
  const cleanCode = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(cleanCode)) {
    return NextResponse.json({ error: "Kod 6 haneli olmalı", field: "code" }, { status: 400 });
  }
  const normalized = normalizeEmail(email as string);

  // E-posta sınırı biçim doğrulamasından SONRA: bozuk girdi kimsenin sayacını
  // doldurmasın. Farklı IP'lerden aynı hesaba yığılan denemeleri keser.
  if (
    await checkRateLimit(`portal-code-email:${normalized}`, Date.now(), LOGIN_CODE_EMAIL_RATE_MAX)
  ) {
    return NextResponse.json(
      { error: "Bu adres için çok fazla deneme yapıldı, birkaç dakika sonra tekrar dene" },
      { status: 429 }
    );
  }

  const session = await consumeLoginCode(normalized, cleanCode);
  if (!session) {
    return NextResponse.json(INVALID_CODE, { status: 401 });
  }

  // Link akışıyla (`verify/route.ts`) aynı oturum kurulumu.
  const response = NextResponse.json({ ok: true });
  setClientSessionCookie(response, session);
  return response;
}
