import type { ReactNode } from "react";
import type { PortalApp } from "@/lib/portal-app";

/**
 * Giriş ekranlarının üst bloğu: uygulama ikonu, ad, büyük başlık.
 *
 * Oturum yokken ad ve ikon VARSAYILAN kimlik (K23): hangi müşterinin giriş
 * yapacağını bilmiyoruz; müşteri adını oturumsuz sayfaya basmak kimin
 * portalda olduğunu dışarıya söylemek olurdu.
 */
export function LoginBrand({ app, title }: { app: PortalApp; title: ReactNode }) {
  return (
    <div className="p-login-brand">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${app.iconBase}/icon-192.png`} alt="" className="p-login-icon" width={96} height={96} />
      <span className="p-login-kicker">{app.name.toLocaleUpperCase("tr-TR")}</span>
      <h1 className="p-login-title">{title}</h1>
    </div>
  );
}
