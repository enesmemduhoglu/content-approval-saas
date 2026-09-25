import { redirect } from "next/navigation";
import { getClientSession } from "@/lib/client-auth";
import { getPortalContext } from "@/lib/portal-app";
import { PortalLoginForm } from "@/components/portal/login-form";
import { LoginBrand } from "@/components/portal/login-brand";

export const dynamic = "force-dynamic";

export default async function PortalLoginPage() {
  // Zaten oturumu olan kullanıcı giriş formunu görmesin.
  if (await getClientSession()) redirect("/portal");
  const { app } = await getPortalContext();
  return (
    <main className="p-login">
      <LoginBrand
        app={app}
        title={
          <>
            Video kuyruğuna
            <br />
            giriş
          </>
        }
      />
      <PortalLoginForm />
    </main>
  );
}
