import type { StorageView } from "@/lib/storage-usage";

export type StorageCardState =
  | { kind: "ready"; view: StorageView }
  | { kind: "loading" }
  | { kind: "failed" };

/**
 * Ayarlar'daki depolama kartı: "1,4 GB / 10 GB", ince çubuk, "yaklaşık N video
 * daha". Tasarım: V7 kanvası "Güncelleme 29 Eyl" (ilk sürüm fazla büyük
 * bulundu; tek satırlık kart kaldı).
 *
 * Sunucu bileşeni — veriyi sayfa çeker (`Suspense` içinde, R2 gecikmesi ayar
 * formunu bekletmesin); burası yalnızca çizer. Okunamayınca kart kaybolmaz,
 * "okunamadı" der: boş kalan bölüm hata mı, yükleniyor mu belli olmazdı.
 */
export function StorageCard({ state }: { state: StorageCardState }) {
  return (
    <section className="p-set" aria-labelledby="ayar-depolama">
      <h2 className="p-kicker p-kicker--accent" id="ayar-depolama">
        DEPOLAMA
      </h2>
      <div className="p-set-card p-set-card--storage">
        {state.kind === "ready" && <StorageMeter view={state.view} />}
        {state.kind === "loading" && (
          <div className="p-storage-skel" aria-busy="true" aria-label="Depolama yükleniyor">
            <span className="p-skel p-storage-skel-value" />
            <span className="p-skel p-storage-skel-bar" />
            <span className="p-skel p-storage-skel-line" />
          </div>
        )}
        {state.kind === "failed" && (
          <p className="p-set-sub">Şu an okunamadı. Biraz sonra yeniden dene.</p>
        )}
      </div>
    </section>
  );
}

function StorageMeter({ view }: { view: StorageView }) {
  const tone = view.level === "ok" ? "" : ` p-storage--${view.level}`;
  return (
    <>
      <p className="p-storage-value">
        {view.usedLabel} <span className="p-storage-quota">/ {view.quotaLabel}</span>
      </p>
      <div
        className={`p-storage-bar${tone}`}
        role="meter"
        aria-label="Kullanılan depolama"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.percent}
        aria-valuetext={`${view.usedLabel} / ${view.quotaLabel} kullanılıyor`}
      >
        <span className="p-storage-fill" style={{ width: `${view.percent}%` }} />
      </div>
      <p className={`p-storage-line${tone}`}>{view.line}</p>
    </>
  );
}
