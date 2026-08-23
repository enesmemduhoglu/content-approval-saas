import { NextResponse } from "next/server";
import { auth, unstable_update } from "@/lib/auth";
import { acceptInviteAsSignedInUser } from "@/lib/membership";
import { checkOrigin } from "@/lib/origin";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Davet devrini tetikleyen tek yazma yolu.
 *
 * ─── Neden `getScopedDb` YOK ───────────────────────────────────────────────
 * Depodaki değişmez, "route handler'lar ham `db.*` çağırmaz" diyor; buradaki
 * istisna bilinçli ve dar. `getScopedDb(session)` isteği OTURUMDAKİ ajansa
 * kapsıyor — oysa bu route'un bütün amacı kullanıcıyı oturumundaki ajanstan
 * BAŞKA bir ajansa taşımak. Kapsam filtresi burada koruma değil, işin
 * kendisini imkânsız kılan bir şey olurdu.
 *
 * Yerine geçen koruma daha dar: hedef ajans istekten ALINMIYOR, davet
 * token'ından türetiliyor ve kabul davetin E-POSTASI ile giriş yapılmış
 * hesabın e-postasının eşleşmesine bağlı (bkz. `acceptInviteAsSignedInUser`).
 * Yani saldırganın seçebileceği bir `agencyId` yok: davet edilmediği bir
 * ajansa geçmesi için o ajansın owner'ının ona davet göndermesi gerekir.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const session = await auth();
  // Devrin ÖN KOŞULU giriş yapmış olmak: kim olduğunu bilmediğimiz birinin
  // e-posta eşleşmesini doğrulayamayız. Girişsiz gelen `/invite` sayfasına
  // yönlendirilir, oradan Google'a.
  if (!session?.user?.email || !session.googleId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  // Token 122 bit rastgele, kaba kuvvetle bulunamaz — ama hız sınırı yine de
  // var: anahtar giriş yapmış HESAP, çünkü kabul zaten kimliğe bağlı ve
  // meşru bir kullanıcının aynı daveti saniyede onlarca kez kabul etmesi
  // diye bir şey yok.
  if (await checkRateLimit(`invite-accept:${session.googleId}`)) {
    return NextResponse.json(
      { error: "Çok fazla deneme yapıldı, biraz sonra tekrar deneyin" },
      { status: 429 }
    );
  }

  const { token } = await params;
  const result = await acceptInviteAsSignedInUser({
    googleId: session.googleId,
    email: session.user.email,
    name: session.user.name,
    token,
  });

  if (!result.ok) {
    const message = {
      invite_unavailable:
        "Bu davet artık geçerli değil (süresi dolmuş ya da kullanılmış olabilir)",
      email_mismatch: "Bu davet başka bir e-posta adresine gönderilmiş",
      last_owner_with_data:
        "Şu anki ajansının tek sahibisin ve ajansta müşteri ya da post var. " +
        "Devretmeden önce ajansa başka bir sahip ekle.",
    }[result.reason];
    // 409 "durum uygun değil", 403 "bu hesapla olmaz": ikisi farklı sorun,
    // arayüz de farklı şey söylemeli.
    const status = result.reason === "email_mismatch" ? 403 : 409;
    return NextResponse.json({ error: message }, { status });
  }

  // OTURUMU HEMEN TAZELE. Aksi halde JWT'deki `agencyId` eski ajansı
  // göstermeye 5 dakikaya kadar devam eder (MEMBERSHIP_REVALIDATE_MS) ve
  // kullanıcı "katıldım" dedikten sonra terk ettiği ajansın panelini görür.
  // Bu çağrı jwt callback'ini `trigger: "update"` ile çalıştırıp çerezi
  // yeniden yazıyor.
  //
  // Patlarsa akış DÜŞMÜYOR: devir zaten commit oldu, en kötü ihtimalle
  // oturum 5 dakika içinde kendiliğinden doğru ajansa geçer. Bu yüzden
  // hatayı yutuyoruz ama sessizce değil — yanıttaki `sessionRefreshed`
  // arayüze "bir tur bekleyebilirsin" demesini sağlıyor.
  let sessionRefreshed = true;
  try {
    await unstable_update({});
  } catch (error) {
    sessionRefreshed = false;
    console.error(
      `[invite-accept] oturum tazelenemedi (ajans=${result.membership.agencyId}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // Terk edilen boş ajans BİLEREK silinmiyor: ajans silmek bu depoda ayrı ve
  // bilinçli bir karar (bkz. scripts/bos-ajans-temizligi.mjs'in emniyet
  // zinciri). Burada yalnızca iz bırakıyoruz ki temizlik turunda bulunabilsin.
  if (result.leftAgencyOrphaned && result.leftAgencyId) {
    console.warn(
      `[invite-accept] ajans ${result.leftAgencyId} devirden sonra üyesiz ve boş kaldı — temizlik adayı`
    );
  }

  return NextResponse.json({
    ok: true,
    agencyId: result.membership.agencyId,
    agencyName: result.membership.agencyName,
    role: result.membership.role,
    leftAgencyId: result.leftAgencyId,
    sessionRefreshed,
  });
}
