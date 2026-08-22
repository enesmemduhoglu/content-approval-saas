import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * F6 — davet karşılama sayfası.
 *
 * ─── Bu sayfa ne YAPMIYOR ──────────────────────────────────────────────────
 * Katılımı BAŞLATMIYOR. "Kabul et" diye bir düğmesi yok, hiçbir yazma
 * yapmıyor. Tek işi bağlam göstermek: seni kim davet etti, hangi adrese, ne
 * zamana kadar geçerli.
 *
 * Katılım Google girişinin kendisinde, `auth.ts`in jwt callback'inde oluyor ve
 * TOKEN'A DEĞİL, giriş yapılan hesabın E-POSTASINA bakıyor (bkz.
 * membership.ts). Bu ayrım bir güvenlik sınırı: token tabanlı kabulde bu
 * linki ele geçiren herkes — iletilmiş bir mail, log'a düşmüş bir URL —
 * ajansa girerdi. Böyle çalıştığı için sayfanın kendisi de zararsız: içeriği
 * ne kadar sızarsa sızsın kimseyi ajansa sokmaz.
 *
 * Sayfa yine de davetin e-postasını TAM göstermiyor, maskeliyor: linki
 * bulmuş bir yabancıya ajansın çalışanının adresini vermenin gereği yok, oysa
 * asıl alıcı maskeli hâlden kendi adresini rahatça tanır.
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

  const invite = await db.agencyInvite.findUnique({
    where: { token },
    select: {
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      invitedByEmail: true,
      agencyId: true,
      agency: { select: { name: true } },
    },
  });

  // Zaten bu ajansın üyesiyken linke tıklamak (ör. mail sonradan açıldı):
  // kullanıcıyı ölü bir sayfada bırakmak yerine panele al.
  if (invite && session?.agencyId === invite.agencyId) redirect("/dashboard");

  const expired = invite ? invite.expiresAt.getTime() <= Date.now() : false;
  const used = Boolean(invite?.acceptedAt);

  return (
    <main className="landing">
      <h1>Ekip daveti</h1>
      {!invite && (
        <p>
          Bu davet bağlantısı geçersiz. Bağlantıyı sana gönderen kişiden yeni
          bir davet istemen gerekiyor.
        </p>
      )}
      {invite && used && (
        <p>
          Bu davet zaten kullanılmış. Hesabın varsa giriş yapabilir, yoksa yeni
          bir davet istemen gerekiyor.
        </p>
      )}
      {invite && !used && expired && (
        <p>
          Bu davetin süresi doldu.{" "}
          <strong>{invite.agency.name ?? "Ajans"}</strong> ekibinden yeni bir
          davet istemen gerekiyor.
        </p>
      )}
      {invite && !used && !expired && (
        <>
          <p>
            <strong>{invite.agency.name ?? "Bir ajans"}</strong> seni ekibine{" "}
            {invite.role === "owner" ? "ajans sahibi" : "ekip üyesi"} olarak
            davet etti
            {invite.invitedByEmail ? ` (${invite.invitedByEmail})` : ""}.
          </p>
          <p>
            Katılmak için <strong>{maskEmail(invite.email)}</strong> adresine
            bağlı Google hesabınla giriş yap. Davet yalnızca bu adresle kabul
            edilir — başka bir hesapla girersen ekibe katılmazsın.
          </p>
          <a className="button-primary" href="/api/auth/signin">
            Google ile giriş yap
          </a>
        </>
      )}
      {(!invite || used || expired) && (
        <p>
          <a href="/">Ana sayfaya dön</a>
        </p>
      )}
    </main>
  );
}
