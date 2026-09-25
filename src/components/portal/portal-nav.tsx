"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { IconClock, IconGear, IconPlus, IconQueue } from "@/components/portal/icons";

type Tab = { href: string; label: string; icon: (active: boolean) => ReactNode };

const TABS: Tab[] = [
  {
    href: "/portal",
    label: "Kuyruk",
    // Aktif sekmede çizgi kalınlaşıyor (maket): renk tek başına durum taşımasın.
    icon: (active) => <IconQueue strokeWidth={active ? 2 : 1.8} />,
  },
  {
    href: "/portal/yukle",
    label: "Yükle",
    icon: () => (
      <span className="p-tab-pill">
        <IconPlus size={18} />
      </span>
    ),
  },
  { href: "/portal/gecmis", label: "Geçmiş", icon: (active) => <IconClock strokeWidth={active ? 2 : 1.8} /> },
  { href: "/portal/ayarlar", label: "Ayarlar", icon: (active) => <IconGear strokeWidth={active ? 2 : 1.8} /> },
];

/** "/portal" yalnızca kendisiyle eşleşir; diğer sekmeler alt yollarıyla da. */
export function isActiveTab(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (href === "/portal") return pathname === "/portal";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Portalın alt sekme çubuğu (V7-pwa §4.4). Telefonda başparmağın ulaştığı
 * yerde; masaüstünde de aynı çubuk sütun genişliğinde duruyor — portal tek
 * sütunlu bir "uygulama", iki ayrı gezinme düzeni bakımı gerektirmesin.
 *
 * Yükle turuncu hap: portalın asıl işi video yüklemek, sekmeler arasında
 * gözün ilk onu bulması isteniyor (maket).
 *
 * Çıkış artık burada değil, Ayarlar'ın altında: sekme çubuğunda her an
 * dokunulabilir bir "çıkış" yanlışlıkla oturumu kapatırdı.
 */
export function PortalTabBar() {
  const pathname = usePathname();
  return (
    <nav className="p-tabbar" aria-label="Ana gezinme">
      <div className="p-tabbar-inner">
        {TABS.map((tab) => {
          const active = isActiveTab(tab.href, pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="p-tab"
              aria-current={active ? "page" : undefined}
            >
              {tab.icon(active)}
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
