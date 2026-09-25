import Link from "next/link";
import type { ReactNode } from "react";
import { PortalTabBar } from "@/components/portal/portal-nav";
import { IconSliders } from "@/components/portal/icons";

/**
 * Sekmeli portal sayfalarının ortak kabuğu: güvenli alan paylı sütun + alt
 * sekme çubuğu. Video detayı ve giriş bunu kullanmıyor — maketlerde onların
 * kendi üst/alt çubukları var.
 *
 * `brand` verilince başlık müşterinin ikonu ve adıyla çıkıyor (Kuyruk
 * maketindeki gibi). Diğer sekmelerde yalnızca büyük başlık: ikon + ad her
 * ekranda tekrar edince başlık alanı iki satıra taşıyor ve içerik aşağı
 * iniyordu; maketler de böyle.
 */
export function PortalShell({
  title,
  brand,
  lead,
  className,
  children,
}: {
  title: string;
  brand?: { name: string; iconSrc: string };
  lead?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <>
      <main className={`p-page${className ? ` ${className}` : ""}`}>
        {brand ? (
          <header className="p-head">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={brand.iconSrc} alt="" className="p-head-icon" width={44} height={44} />
            <div className="p-head-text">
              <span className="p-head-name">{brand.name}</span>
              <h1 className="p-title">{title}</h1>
            </div>
            <Link href="/portal/ayarlar" className="p-head-action" aria-label="Ayarlar">
              <IconSliders size={20} />
            </Link>
          </header>
        ) : (
          <header className="p-titleblock">
            <h1 className="p-title">{title}</h1>
            {lead ? <p className="p-lead">{lead}</p> : null}
          </header>
        )}
        {children}
      </main>
      <PortalTabBar />
    </>
  );
}
