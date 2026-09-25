"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { MAX_FILES, useVideoUpload, type ItemPhase } from "@/components/portal/use-video-upload";

const PHASE_LABEL: Record<ItemPhase, string> = {
  bekliyor: "Sırada",
  hazırlanıyor: "Kareler çıkarılıyor",
  yükleniyor: "Yükleniyor",
  tamamlanıyor: "Kuyruğa ekleniyor",
  bitti: "Kuyrukta",
  hata: "Hata",
};

const ACCEPT = "video/mp4,video/quicktime";

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Çoklu video yükleme ekranı. Akışın mantığı (taslak, tek PUT / çok parçalı
 * yükleme, kaldığı yerden devam, ekran kilidi) `use-video-upload.ts`'te; bu
 * bileşen yalnızca görünüm — mobil tasarım geldiğinde yalnızca burası değişir.
 */
export function UploadForm() {
  const router = useRouter();
  const { files, items, running, error, doneCount, pick, start } = useVideoUpload({
    onFinished: () => router.refresh(),
  });

  return (
    <div className="card upload-card">
      <label className="upload-picker">
        <span>Videoları seç (en fazla {MAX_FILES}, her biri ≤ 300 MB, ≤ 90 sn, dikey)</span>
        <input
          type="file"
          accept={ACCEPT}
          multiple
          disabled={running}
          onChange={(e) => pick(e.target.files)}
        />
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {items.length > 0 && (
        <ul className="upload-list">
          {items.map((item) => (
            <li key={item.key} className="upload-row">
              <div className="upload-row-head">
                <span className="upload-name">{item.name}</span>
                <span className="post-date">{mb(item.size)}</span>
              </div>
              <progress
                className="upload-progress"
                max={1}
                value={item.phase === "bitti" ? 1 : item.progress}
                aria-label={`${item.name} yükleme ilerlemesi`}
              />
              <span className={item.phase === "hata" ? "field-error" : "settings-hint"}>
                {PHASE_LABEL[item.phase]}
                {item.phase === "yükleniyor" && ` — %${Math.round(item.progress * 100)}`}
                {item.error && `: ${item.error}`}
              </span>
              {item.status && item.phase !== "hata" && (
                <span className="settings-hint" role="status">
                  {item.status}
                </span>
              )}
              {item.note && <span className="settings-hint">{item.note}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="button-primary"
          disabled={running || files.length === 0}
          onClick={start}
        >
          {running ? "Yükleniyor…" : `Yükle${files.length ? ` (${files.length})` : ""}`}
        </button>
        {doneCount > 0 && !running && (
          <Link href="/portal" className="button-secondary">
            Kuyruğa git ({doneCount} video eklendi)
          </Link>
        )}
      </div>
      <p className="settings-hint">
        Yükleme bitene kadar bu sayfayı kapatma. Uygulamadan çıkarsan döndüğünde kaldığı yerden
        devam eder. Caption'lar yüklemeden sonra birkaç dakikada hazırlanır.
      </p>
    </div>
  );
}
