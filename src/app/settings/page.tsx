import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getScopedDb } from "@/lib/scoped-db";
import { AppNav } from "@/components/nav";
import { BrandingForm } from "@/components/branding-form";
import { TeamPanel } from "@/components/team-panel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.agencyId) redirect("/api/auth/signin");

  const scoped = getScopedDb(session);
  const [agency, members, invites] = await Promise.all([
    db.agency.findUnique({
      where: { id: session.agencyId },
      select: { name: true, logoUrl: true, brandColor: true },
    }),
    // Ham `db.agencyMember` DEĞİL: kapsam filtresi tek yerde (scoped-db)
    // dursun — sayfa da route gibi bu sözleşmeye uyuyor.
    scoped.members.findMany(),
    scoped.invites.findPending(),
  ]);

  // "Sen" işareti için: oturumdaki e-postaya karşılık gelen üye satırı.
  const currentEmail = session.user?.email?.trim().toLowerCase() ?? null;
  const currentMemberId =
    members.find((member) => member.email === currentEmail)?.id ?? null;

  return (
    <>
      <AppNav agencyName={session.agencyName ?? "Ajans"} />
      <main className="container">
        <div className="page-head">
          <h1>Ayarlar</h1>
        </div>
        <h2>Markalama</h2>
        <p className="settings-hint">
          Logo ve marka rengin, müşterinin gördüğü onay sayfasında ve onay
          e-postalarında kullanılır.
        </p>
        <BrandingForm
          logoUrl={agency?.logoUrl ?? null}
          brandColor={agency?.brandColor ?? null}
        />

        <h2>Ekip</h2>
        <p className="settings-hint">
          Aynı ajansta çalışan herkes aynı müşterileri ve postları görür. Ekip
          üyeleri post ve müşteri işlerinin tamamını yapabilir; davet etmek ve
          üye çıkarmak yalnızca ajans sahibinin yetkisindedir.
        </p>
        <TeamPanel
          members={members}
          invites={invites.map((invite) => ({
            ...invite,
            expiresAt: invite.expiresAt.toISOString(),
          }))}
          isOwner={session.agencyRole === "owner"}
          currentMemberId={currentMemberId}
        />
      </main>
    </>
  );
}
