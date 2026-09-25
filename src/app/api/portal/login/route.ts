import { after, NextResponse } from "next/server";
import { requestLoginLink } from "@/lib/client-auth";
import { normalizeEmail } from "@/lib/membership";
import { checkOrigin } from "@/lib/origin";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { validateClientEmail } from "@/lib/validation";

/**
 * Video kuyruğu (V3) — portal giriş linki isteği.
 *
 * ─── E-posta sızdırmama ────────────────────────────────────────────────────
 * Yanıt, adres kayıtlı olsa da olmasa da BİREBİR aynı (gövde ve durum kodu).
 * Süre de aynı: kullanıcı araması, token üretimi ve Resend çağrısı yanıt
 * gittikten SONRA `after()` içinde koşuyor. Aksi hâlde kayıtlı adres mail
 * gönderimi kadar (~yüzlerce ms) geç dönerdi ve zamanlama tek başına
 * "bu adres müşteri" diye cevap verirdi.
 *
 * ─── Hız sınırı iki anahtarda ──────────────────────────────────────────────
 *  • IP: tek bir istemcinin adres listesi deneyip durmasını keser.
 *  • E-posta: farklı IP'lerden aynı kutuya mail yağdırılmasını keser (Resend
 *    kotası da ajansın; birinin kutusu spam'le dolmasın).
 */
const LOGIN_EMAIL_RATE_MAX = 3;

const GENERIC_OK = {
  ok: true,
  message: "Bu adres kayıtlıysa birkaç dakika içinde bir giriş linki ve kodu gelecek.",
};

function appBaseUrl(request: Request): string {
  return process.env.APP_URL ?? new URL(request.url).origin;
}

export async function POST(request: Request) {
  // Oturum adımı yok: bu route oturumun kendisini başlatıyor.
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  const ip = getClientIp(request.headers);
  if (await checkRateLimit(`portal-login-ip:${ip}`)) {
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
  const { email } = (body ?? {}) as { email?: unknown };
  const emailError = validateClientEmail(email);
  if (emailError) {
    return NextResponse.json({ error: emailError, field: "email" }, { status: 400 });
  }
  const normalized = normalizeEmail(email as string);

  // E-posta anahtarlı sınır adres doğrulamasından SONRA: bozuk girdiler kimsenin
  // sayacını doldurmasın. Aşıldığında da yanıt kayıtlılıktan bağımsız.
  if (await checkRateLimit(`portal-login-email:${normalized}`, Date.now(), LOGIN_EMAIL_RATE_MAX)) {
    return NextResponse.json(
      { error: "Bu adres için çok fazla link istendi, birkaç dakika sonra tekrar deneyin" },
      { status: 429 }
    );
  }

  const baseUrl = appBaseUrl(request);
  after(async () => {
    try {
      await requestLoginLink(normalized, baseUrl);
    } catch (error) {
      // Adres log'a yazılmaz — log'a bakan biri de kayıtlılığı öğrenemesin.
      console.error("[portal-login] giriş linki üretilemedi", (error as Error).message);
    }
  });

  return NextResponse.json(GENERIC_OK);
}
