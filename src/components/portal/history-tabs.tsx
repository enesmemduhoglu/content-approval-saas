"use client";

import { useState, type ReactNode } from "react";

/**
 * Geçmiş ekranının Yayınlanan / Başarısız sekmeleri (WAI-ARIA tab deseni).
 * Paneller sunucuda çiziliyor ve buraya hazır geliyor; bu bileşen yalnızca
 * hangisinin görüneceğini seçiyor — liste verisi istemciye ikinci kez
 * taşınmasın.
 *
 * Başarısız video varsa ve yayınlanan yoksa ilk açılışta Başarısız sekmesi:
 * boş bir listeye bakıp "hiçbir şey olmamış" sanılmasın.
 */
export function HistoryTabs({
  publishedCount,
  failedCount,
  published,
  failed,
}: {
  publishedCount: number;
  failedCount: number;
  published: ReactNode;
  failed: ReactNode;
}) {
  const [tab, setTab] = useState<"published" | "failed">(
    publishedCount === 0 && failedCount > 0 ? "failed" : "published"
  );
  const tabs = [
    { key: "published" as const, label: `Yayınlanan · ${publishedCount}` },
    { key: "failed" as const, label: `Başarısız · ${failedCount}` },
  ];

  function onKeyDown(event: React.KeyboardEvent) {
    // Sekme listesi içinde oklar sekmeler arasında dolaşır (ARIA tab deseni).
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "published" ? "failed" : "published";
    setTab(next);
    document.getElementById(`gecmis-sekme-${next}`)?.focus();
  }

  return (
    <>
      <div className="p-seg" role="tablist" aria-label="Geçmiş filtresi" onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.key}
            id={`gecmis-sekme-${t.key}`}
            type="button"
            role="tab"
            className="p-seg-tab"
            aria-selected={tab === t.key}
            aria-controls={`gecmis-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        id="gecmis-panel-published"
        role="tabpanel"
        aria-labelledby="gecmis-sekme-published"
        hidden={tab !== "published"}
      >
        {published}
      </div>
      <div
        id="gecmis-panel-failed"
        role="tabpanel"
        aria-labelledby="gecmis-sekme-failed"
        hidden={tab !== "failed"}
      >
        {failed}
      </div>
    </>
  );
}
