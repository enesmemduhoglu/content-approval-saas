"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { extractFrames, probeError, putWithProgress } from "@/lib/frames-client";

type ItemState = {
  key: string;
  name: string;
  size: number;
  phase: "bekliyor" | "hazırlanıyor" | "yükleniyor" | "tamamlanıyor" | "bitti" | "hata";
  progress: number;
  error?: string;
  note?: string;
};

type UploadItem = { postId: string; videoPutUrl: string; framePutUrls: string[] };

const PHASE_LABEL: Record<ItemState["phase"], string> = {
  bekliyor: "Sırada",
  hazırlanıyor: "Kareler çıkarılıyor",
  yükleniyor: "Yükleniyor",
  tamamlanıyor: "Kuyruğa ekleniyor",
  bitti: "Kuyrukta",
  hata: "Hata",
};

const ACCEPT = "video/mp4,video/quicktime";
const MAX_FILES = 20;

/**
 * Bazı tarayıcılar (.mov'da Windows Chrome'u gibi) `file.type`'ı boş verir.
 * Uzantıdan tamamlanıyor; imzalı PUT'un tipi de AYNI fonksiyondan gelmeli,
 * yoksa R2 imza uyuşmazlığıyla 403 döner.
 */
function videoType(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".mov")) return "video/quicktime";
  if (name.endsWith(".mp4")) return "video/mp4";
  return "";
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Çoklu video yükleme (README §7):
 *   1. Her dosya tarayıcıda ölçülür (≤ 90 sn, dikey) ve 6 kare çıkarılır.
 *   2. Geçen dosyalar için TEK istekte taslak + imzalı URL'ler alınır.
 *   3. Video ve kareler doğrudan R2'ye PUT edilir (ilerleme çubuğuyla).
 *   4. `complete` dosyanın gerçekten yüklendiğini doğrular ve kuyruğa ekler.
 *
 * Videolar SIRAYLA yüklenir: telefonda paralel 300 MB'lık yüklemeler bant
 * genişliğini bölüp hepsini yavaşlatır, biri koptuğunda da hangisinin
 * bittiği belirsizleşir.
 */
export function UploadForm() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [items, setItems] = useState<ItemState[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(key: string, next: Partial<ItemState>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...next } : item)));
  }

  function onPick(list: FileList | null) {
    setError(null);
    const picked = Array.from(list ?? []);
    if (picked.length > MAX_FILES) {
      setError(`Tek seferde en fazla ${MAX_FILES} video seçebilirsin`);
      return;
    }
    setFiles(picked);
    setItems(
      picked.map((file, i) => ({
        key: `${i}-${file.name}`,
        name: file.name,
        size: file.size,
        phase: "bekliyor",
        progress: 0,
      }))
    );
  }

  async function start() {
    if (running || files.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      // 1) Ölç + kare çıkar (sırayla — her biri belleğe bir video açıyor).
      const prepared: { file: File; key: string; frames: Blob[] }[] = [];
      for (const [i, file] of files.entries()) {
        const key = items[i].key;
        patch(key, { phase: "hazırlanıyor" });
        const { probe, frames } = await extractFrames(file);
        const problem = probeError(probe);
        if (problem) {
          patch(key, { phase: "hata", error: problem });
          continue;
        }
        patch(key, {
          phase: "bekliyor",
          note: frames.length === 0 ? "Kare çıkarılamadı; caption yalnızca sesten üretilecek" : undefined,
        });
        prepared.push({ file, key, frames });
      }
      if (prepared.length === 0) return;

      // 2) Taslaklar + imzalı URL'ler, tek istekte.
      const res = await fetch("/api/portal/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: prepared.map(({ file }) => ({ contentType: videoType(file), size: file.size })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Yükleme başlatılamadı");
        for (const p of prepared) patch(p.key, { phase: "hata", error: "Başlatılamadı" });
        return;
      }
      const uploads = data.items as UploadItem[];

      // 3–4) Sırayla yükle + tamamla.
      for (const [i, p] of prepared.entries()) {
        const target = uploads[i];
        try {
          patch(p.key, { phase: "yükleniyor", progress: 0 });
          await putWithProgress(target.videoPutUrl, p.file, videoType(p.file), (fraction) =>
            patch(p.key, { progress: fraction })
          );
          // Kare yüklemesi başarısız olabilir; video yine kuyruğa girer.
          await Promise.all(
            p.frames.map((frame, n) =>
              target.framePutUrls[n]
                ? putWithProgress(target.framePutUrls[n], frame, "image/jpeg").catch(() => undefined)
                : undefined
            )
          );
          patch(p.key, { phase: "tamamlanıyor", progress: 1 });
          const done = await fetch(`/api/portal/videos/${target.postId}/complete`, { method: "POST" });
          if (!done.ok) {
            const body = await done.json().catch(() => ({}));
            throw new Error(body.error ?? "Kuyruğa eklenemedi");
          }
          patch(p.key, { phase: "bitti" });
        } catch (err) {
          patch(p.key, { phase: "hata", error: (err as Error).message });
        }
      }
      router.refresh();
    } finally {
      setRunning(false);
    }
  }

  const doneCount = items.filter((i) => i.phase === "bitti").length;

  return (
    <div className="card upload-card">
      <label className="upload-picker">
        <span>Videoları seç (en fazla {MAX_FILES}, her biri ≤ 300 MB, ≤ 90 sn, dikey)</span>
        <input
          type="file"
          accept={ACCEPT}
          multiple
          disabled={running}
          onChange={(e) => onPick(e.target.files)}
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
        Yükleme bitene kadar bu sayfayı kapatma. Caption'lar yüklemeden sonra birkaç dakikada
        hazırlanır.
      </p>
    </div>
  );
}
