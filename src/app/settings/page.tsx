import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppNav } from "@/components/nav";
import { BrandingForm } from "@/components/branding-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.agencyId) redirect("/api/auth/signin");

  const agency = await db.agency.findUnique({
    where: { id: session.agencyId },
    select: { name: true, logoUrl: true, brandColor: true },
  });

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
      </main>
    </>
  );
}
