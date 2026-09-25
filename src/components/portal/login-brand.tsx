import type { ReactNode } from "react";
import type { PortalApp } from "@/lib/portal-app";

/**
 * Giriş ekranlarının üst bloğu: uygulama ikonu, ad, büyük başlık.
 *
 * Oturum yokken ad ve ikon, bu cihazda en son giriş yapılan müşterinin
 * (imzalı iz çerezi, K29); iz yoksa VARSAYILAN kimlik (K23). Müşteri adı
 * yalnızca o müşteriye daha önce giriş yapılmış cihaza gösteriliyor — iz
 * olmayan bir ziyaretçi kimin portalda olduğunu buradan öğrenemez. E-posta
 * ya da başka kişisel bilgi bu blokta hiçbir zaman yer almaz.
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
