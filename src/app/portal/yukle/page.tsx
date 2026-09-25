import { requirePortalSession } from "@/lib/portal-page";
import { PortalShell } from "@/components/portal/portal-shell";
import { UploadForm } from "@/components/portal/upload-form";

export const dynamic = "force-dynamic";

export default async function PortalUploadPage() {
  await requirePortalSession();
  return (
    <PortalShell
      title="Yükle"
      // K24: kırpma/renk düzeltmesi yok — kullanıcı videoyu telefonunda hazırlıyor.
      lead="Videoyu telefonunda hazırla (kırpma, renk), buradan yükle. Video olduğu gibi yayınlanır."
    >
      <UploadForm />
    </PortalShell>
  );
}
