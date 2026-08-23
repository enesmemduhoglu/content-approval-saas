import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveInviteView } from "@/lib/membership";
import { InviteAccept } from "@/components/invite-accept";

export const dynamic = "force-dynamic";

/**
 * F6 — davet karşılama sayfası.
 *
 * ─── Bu sayfa ne YAPMIYOR ──────────────────────────────────────────────────
 * Kendisi hiçbir şey YAZMIYOR. Tek işi bağlam göstermek ve doğru düğmeyi
 * çıkarmak: seni kim davet etti, hangi adrese, ne zamana kadar geçerli, ve
 * kabul etmek için ne yapman gerekiyor.
 *
 * İki farklı kabul yolu var, ikisi de bu sayfanın DIŞINDA:
 *
 *  1. **Hiç hesabı olmayan / hiçbir ajansa üye olmayan** biri: kabul Google
 *     girişinin kendisinde oluyor (`auth.ts` jwt callback → `membership.ts`)
 *     ve TOKEN'A DEĞİL, giriş yapılan hesabın E-POSTASINA bakıyor. Bu ayrım
 *     bir güvenlik sınırı: token tabanlı kabulde bu linki ele geçiren herkes
 *     — iletilmiş bir mail, log'a düşmüş bir URL — ajansa girerdi.
 *
 *  2. **Zaten başka bir ajansın üyesi** olan biri: giriş onu kendi ajansına
 *     düşürür ve daveti göremezdi (F6'nın gözden kaçan durumu). Onun için
 *     açık bir DEVİR onayı var — `InviteAccept` düğmesi
 *     `/api/invites/<token>/accept`e gidiyor. Kabul koşulu yine e-posta
 *     eşleşmesi; token yalnızca "hangi davet" sorusunu cevaplıyor.
 *
 * Sayfa davetin e-postasını TAM göstermiyor, maskeliyor: linki bulmuş bir
 * yabancıya ajansın çalışanının adresini vermenin gereği yok, oysa asıl alıcı
 * maskeli hâlden kendi adresini rahatça tanır. (Giriş yapılmışsa maskeye
 * gerek yok — adresi zaten kendisi taşıyor.)
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  const head = local.slice(0, 2);
  return `${head}${"•".repeat(Math.max(3, local.length - 2))}@${domain}`;
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await auth();

  const view = await resolveInviteView({
    token,
    signedInEmail: session?.user?.email ?? null,
    googleId: session?.googleId ?? null,
  });

  // Giriş linki KENDİ SAYFASINA geri dönüyor. Öncesinde `callbackUrl` yoktu
  // ve kullanıcı girişten sonra "/"a düşüyordu: davet zaten girişte kabul
  // edildiyse fark etmez, ama devir gereken durumda onay düğmesini bir daha
  // hiç görmezdi.
  const signInUrl = `/api/auth/signin?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`;

  // Zaten hedef ajansın üyesi (ör. mail sonradan açıldı): ölü bir sayfada
  // bırakmak yerine panele al.
  if (view.kind === "already_member") redirect("/dashboard");

  return (
    <main className="landing">
      <h1>Ekip daveti</h1>

      {view.kind === "not_found" && (
        <p>
          Bu davet bağlantısı geçersiz. Bağlantıyı sana gönderen kişiden yeni
          bir davet istemen gerekiyor.
        </p>
      )}

      {view.kind === "used" && (
        <p>
          Bu davet zaten kullanılmış. Hesabın varsa giriş yapabilir, yoksa yeni
          bir davet istemen gerekiyor.
        </p>
      )}

      {view.kind === "expired" && (
        <p>
          Bu davetin süresi doldu.{" "}
          <strong>{view.agencyName ?? "Ajans"}</strong> ekibinden yeni bir
          davet istemen gerekiyor.
        </p>
      )}

      {view.kind === "anonymous" && (
        <>
          <p>
            <strong>{view.agencyName ?? "Bir ajans"}</strong> seni ekibine{" "}
            {view.role === "owner" ? "ajans sahibi" : "ekip üyesi"} olarak
            davet etti
            {view.invitedByEmail ? ` (${view.invitedByEmail})` : ""}.
          </p>
          <p>
            Katılmak için <strong>{maskEmail(view.email)}</strong> adresine
            bağlı Google hesabınla giriş yap. Davet yalnızca bu adresle kabul
            edilir — başka bir hesapla girersen ekibe katılmazsın.
          </p>
          <a className="button-primary" href={signInUrl}>
            Google ile giriş yap
          </a>
        </>
      )}

      {view.kind === "wrong_account" && (
        <>
          <p>
            Bu davet <strong>{maskEmail(view.email)}</strong> adresine
            gönderilmiş, ama şu an <strong>{view.signedInAs}</strong> hesabıyla
            giriş yapmış durumdasın. Davet yalnızca gönderildiği adresle kabul
            edilebilir.
          </p>
          <p>
            Çıkış yapıp doğru Google hesabıyla tekrar gir, sonra bu bağlantıyı
            yeniden aç.
          </p>
          <a className="button-primary" href="/api/auth/signout">
            Çıkış yap
          </a>
        </>
      )}

      {view.kind === "transfer" && !view.blocked && (
        <>
          <p>
            <strong>{view.agencyName ?? "Bir ajans"}</strong> seni ekibine{" "}
            {view.role === "owner" ? "ajans sahibi" : "ekip üyesi"} olarak
            davet etti
            {view.invitedByEmail ? ` (${view.invitedByEmail})` : ""}.
          </p>
          <InviteAccept
            token={token}
            agencyName={view.agencyName}
            role={view.role}
            currentAgencyName={view.currentAgencyName}
            currentAgencyEmpty={view.currentAgencyEmpty}
          />
        </>
      )}

      {view.kind === "transfer" && view.blocked && (
        <>
          <p>
            <strong>{view.agencyName ?? "Bir ajans"}</strong> seni ekibine
            davet etti, ama şu an bu daveti kabul edemezsin: mevcut ajansının
            (<strong>{view.currentAgencyName ?? "adsız ajans"}</strong>) TEK
            sahibisin ve ajansta müşteri ya da post var. Ayrılman o verileri
            sahipsiz bırakır — kimse davet edemez, kimse üye çıkaramaz.
          </p>
          <p>
            Önce mevcut ajansına ikinci bir <em>ajans sahibi</em> ekle, sonra
            bu bağlantıyı yeniden aç.
          </p>
          <p>
            <a href="/settings">Ekip ayarlarına git</a>
          </p>
        </>
      )}

      {(view.kind === "not_found" ||
        view.kind === "used" ||
        view.kind === "expired") && (
        <p>
          <a href="/">Ana sayfaya dön</a>
        </p>
      )}
    </main>
  );
}
