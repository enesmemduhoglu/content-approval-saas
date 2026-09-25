import { getPortalContext } from "@/lib/portal-app";
import { PortalVerifyButton } from "@/components/portal/login-form";
import { LoginBrand } from "@/components/portal/login-brand";

export const dynamic = "force-dynamic";

/**
 * Giriş linkinin açtığı sayfa. Token'ı BURADA tüketmiyoruz: e-posta
 * tarayıcıları linki GET'le önceden açar ve tek kullanımlık token o anda
 * harcanırdı. Tüketim butonun POST'unda (bkz. api/portal/login/verify).
 */
export default async function PortalVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  const value = typeof token === "string" ? token : "";
  const { app } = await getPortalContext();

  return (
    <main className="p-login">
      {value ? (
        <>
          <LoginBrand app={app} title="Giriş yap" />
          <p className="p-login-lead">Bu cihazda portala giriş yapmak için butona bas.</p>
          <PortalVerifyButton token={value} />
        </>
      ) : (
        <>
          <LoginBrand app={app} title="Link eksik" />
          <p className="p-login-lead">
            Bu adres bir giriş linki içermiyor. <a href="/portal/giris">Yeni kod iste</a>.
          </p>
        </>
      )}
    </main>
  );
}
