import { NextResponse } from "next/server";
import { CLIENT_SESSION_COOKIE, sessionCookieOptions } from "@/lib/client-auth";
import { checkOrigin } from "@/lib/origin";

/**
 * Portal çıkışı: çerezi siler. Oturum durumsuz (imzalı çerez), sunucuda
 * silinecek satır yok — bkz. client-auth.ts.
 *
 * Giriş ekranı izi (`CLIENT_TRACE_COOKIE`, K29) BİLİNÇLİ olarak silinmiyor:
 * işi tam da çıkıştan sonra giriş ekranında bu cihazın müşterisinin adını ve
 * ikonunu göstermek. İz hiçbir yetki vermediği için kalması oturumu açık
 * bırakmak anlamına gelmez.
 *
 * `checkOrigin` burada da var: cross-site bir form kullanıcıyı sessizce
 * çıkış yaptıramasın (zararı küçük ama bedeli sıfır).
 */
export async function POST(request: Request) {
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(CLIENT_SESSION_COOKIE, "", {
    ...sessionCookieOptions(new Date(0)),
    maxAge: 0,
  });
  return response;
}
