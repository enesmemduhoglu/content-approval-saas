"use client";

import { usePathname } from "next/navigation";
import { PortalTabBar } from "@/components/portal/portal-nav";

/** Sekmeli sayfaların başlıkları — iskelet, gelecek sayfanın başlığıyla açılsın. */
const TAB_TITLES: Record<string, string> = {
  "/portal": "Kuyruk",
  "/portal/yukle": "Yükle",
  "/portal/gecmis": "Geçmiş",
  "/portal/ayarlar": "Ayarlar",
};

/**
 * Portalın yükleme iskeleti (`app/portal/loading.tsx`). Sayfalar
 * `force-dynamic`: bu sınır yokken sekmeye dokunmak sunucu yanıtı gelene
 * kadar (telefonda mobil veriyle ~0,5–1 sn, soğuk başlangıçta daha fazla)
 * ekranda HİÇBİR ŞEY değiştirmiyordu — uygulama "donmuş" hissi veriyordu.
 * Sınır varken Next iskeleti önceden indirir, dokunuş anında gösterir;
 * veri gelince asıl sayfa yerine oturur.
 *
 * Sekme çubuğu yalnızca sekmeli sayfalarda: video detayının kendi eylem
 * çubuğu var, orada sekmeler bir an görünüp kaybolurdu.
 */
export function PortalLoading() {
  const pathname = usePathname();
  const title = pathname ? TAB_TITLES[pathname] : undefined;

  return (
    <>
      <main className="p-page" aria-busy="true">
        <p className="sr-only" role="status">
          Yükleniyor…
        </p>
        {title === "Kuyruk" ? (
          <header className="p-head">
            <span className="p-head-icon p-skel-pulse" aria-hidden="true" />
            <div className="p-head-text">
              <span className="p-skel p-skel-pulse p-skel--name" aria-hidden="true" />
              <h1 className="p-title">{title}</h1>
            </div>
          </header>
        ) : title ? (
          <header className="p-titleblock">
            <h1 className="p-title">{title}</h1>
          </header>
        ) : null}
        <div className="p-skel-card p-skel-pulse p-skel-card--tall" aria-hidden="true" />
        <div className="p-skel-card p-skel-pulse" aria-hidden="true" />
        <div className="p-skel-card p-skel-pulse" aria-hidden="true" />
      </main>
      {title && <PortalTabBar />}
    </>
  );
}
