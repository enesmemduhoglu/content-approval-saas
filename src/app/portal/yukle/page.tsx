import { getClientScopedDb } from "@/lib/client-scoped-db";
import { requirePortalSession } from "@/lib/portal-page";
import { PortalNav } from "@/components/portal/portal-nav";
import { UploadForm } from "@/components/portal/upload-form";

export const dynamic = "force-dynamic";

export default async function PortalUploadPage() {
  const session = await requirePortalSession();
  const client = await getClientScopedDb(session).client.get();
  return (
    <>
      <PortalNav clientName={client?.name ?? "Portal"} />
      <main className="container portal-main">
        <h1>Video yükle</h1>
        <p className="settings-hint">
          Videolara hiçbir işlem yapılmaz; her biri için caption otomatik hazırlanır ve kuyruğun
          sonuna eklenir.
        </p>
        <UploadForm />
      </main>
    </>
  );
}
