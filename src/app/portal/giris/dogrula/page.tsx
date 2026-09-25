import { PortalVerifyButton } from "@/components/portal/login-form";

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

  return (
    <main className="approve-page portal-login">
      <header className="approve-header">
        <span>Video Portalı</span>
      </header>
      {value ? (
        <>
          <h1>Giriş yap</h1>
          <p className="settings-hint">Bu cihazda portala giriş yapmak için butona bas.</p>
          <PortalVerifyButton token={value} />
        </>
      ) : (
        <>
          <h1>Link eksik</h1>
          <p className="settings-hint">
            Bu adres bir giriş linki içermiyor. <a href="/portal/giris">Yeni link iste</a>.
          </p>
        </>
      )}
    </main>
  );
}
