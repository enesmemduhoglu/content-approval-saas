import { NextResponse } from "next/server";
import { consumeLoginToken, setClientSessionCookie } from "@/lib/client-auth";
import { checkOrigin } from "@/lib/origin";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * Video kuyruğu (V3) — giriş linkindeki token'ı tüketip portal oturumunu kurar.
 *
 * Neden GET linki doğrudan tüketmiyor: kurumsal e-posta tarayıcıları (Outlook
 * Safe Links vb.) maildeki her linki önceden GET'le açıyor. Tek kullanımlık
 * token o GET'te harcanırsa kullanıcı tıkladığında "link geçersiz" görür.
 * Link bu yüzden yalnızca bir sayfa açar; token, sayfadaki "Giriş yap"
 * butonunun POST'uyla burada tüketilir.
 */
export async function POST(request: Request) {
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  // Token tahmini IP başına sınırlı; 122 bitlik uzayda zaten umutsuz ama
  // endpoint'in DB'yi dövmek için kullanılmasını da engelliyor.
  const ip = getClientIp(request.headers);
  if (await checkRateLimit(`portal-verify-ip:${ip}`)) {
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
  const { token } = (body ?? {}) as { token?: unknown };
  if (typeof token !== "string" || !token) {
    return NextResponse.json({ error: "Geçersiz link", field: "token" }, { status: 400 });
  }

  const session = await consumeLoginToken(token);
  if (!session) {
    // Kullanılmış, süresi dolmuş ve hiç var olmamış token AYNI yanıtı alır:
    // hangisi olduğunu söylemek, token uzayını tarayana ipucu verirdi.
    return NextResponse.json(
      { error: "Bu giriş linki geçersiz ya da süresi dolmuş. Yeni bir link iste." },
      { status: 410 }
    );
  }

  const response = NextResponse.json({ ok: true });
  setClientSessionCookie(response, session);
  return response;
}
