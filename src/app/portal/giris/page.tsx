import { redirect } from "next/navigation";
import { getClientSession } from "@/lib/client-auth";
import { PortalLoginForm } from "@/components/portal/login-form";

export const dynamic = "force-dynamic";

export default async function PortalLoginPage() {
  // Zaten oturumu olan kullanıcı giriş formunu görmesin.
  if (await getClientSession()) redirect("/portal");
  return (
    <main className="approve-page portal-login">
      <header className="approve-header">
        <span>Video Portalı</span>
      </header>
      <h1>Giriş</h1>
      <p className="settings-hint">
        Şifre yok: adresine tek kullanımlık bir giriş linki gönderiyoruz. Link 15 dakika geçerli.
      </p>
      <PortalLoginForm />
    </main>
  );
}
