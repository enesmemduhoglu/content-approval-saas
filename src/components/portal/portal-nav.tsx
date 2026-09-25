"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

const LINKS = [
  { href: "/portal", label: "Kuyruk" },
  { href: "/portal/yukle", label: "Yükle" },
  { href: "/portal/gecmis", label: "Geçmiş" },
  { href: "/portal/ayarlar", label: "Ayarlar" },
];

/**
 * Portal üst çubuğu. Ajans panelinin `AppNav`'ı server action ile NextAuth
 * `signOut` çağırıyor; portal oturumu NextAuth değil, çıkış kendi route'una
 * POST — o yüzden ayrı bileşen.
 */
export function PortalNav({ clientName }: { clientName: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  async function logout() {
    setLeaving(true);
    try {
      await fetch("/api/portal/logout", { method: "POST" });
    } finally {
      router.push("/portal/giris");
      router.refresh();
    }
  }

  return (
    <header className="app-nav portal-nav">
      <span className="app-nav-agency">{clientName}</span>
      <nav aria-label="Portal">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={pathname === link.href ? "page" : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      <button type="button" className="link-button" onClick={logout} disabled={leaving}>
        Çıkış
      </button>
    </header>
  );
}
