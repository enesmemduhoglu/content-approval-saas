"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserImageDeps, prepareAdImage, type ImageDeps } from "@/lib/ad-image-client";
import { AD_CONTENT_TYPE, MAX_FILES_PER_UPLOAD } from "@/lib/portal-validation";
import { IconCheck, IconUpload } from "@/components/portal/icons";
import { fileSize } from "@/components/portal/upload-form";

/**
 * V12b — reklam görseli yükleme (K36). Video yüklemesinin (`use-video-upload`)
 * sade ikizi: görsel ≤ 8 MB olduğu için çok parçalı yükleme, kaldığı yerden
 * devam ve ekran kilidi yok — yarım kalan görsel yeniden seçilir, yarım
 * taslağı 24 saatte `draft-cleanup` temizler.
 *
 * Akış: tarayıcıda hazırla (oran kontrolü, gerekirse JPEG'e çevir) → tek
 * istekte taslaklar + imzalı PUT'lar → R2'ye doğrudan PUT → `complete`.
 */

type Phase = "hazırlanıyor" | "reddedildi" | "yükleniyor" | "tamamlanıyor" | "bitti" | "hata";

type Item = {
  key: string;
  name: string;
  size: number;
  thumb: string | null;
  phase: Phase;
  error?: string;
};

const PHASE_TEXT: Record<Phase, string> = {
  hazırlanıyor: "Hazırlanıyor…",
  reddedildi: "Yüklenmedi",
  yükleniyor: "Yükleniyor…",
  tamamlanıyor: "Havuza ekleniyor…",
  bitti: "Reklam havuzuna eklendi",
  hata: "Yüklenemedi",
};

/** Aynı anda kaç görsel R2'ye gider — mobil bağlantıyı tek dosyaya boğmadan. */
const CONCURRENCY = 3;

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
    })
  );
}

export function AdUploader({ deps = browserImageDeps }: { deps?: ImageDeps }) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thumbs = useRef<string[]>([]);

  // Önizleme adresleri sayfadan çıkınca bırakılır (bellek).
  useEffect(() => () => thumbs.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const patch = useCallback((key: string, next: Partial<Item>) => {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...next } : item)));
  }, []);

  async function pick(list: FileList | null) {
    const files = list ? Array.from(list) : [];
    if (files.length === 0 || running) return;
    setError(null);
    if (files.length > MAX_FILES_PER_UPLOAD) {
      setError(`Tek seferde en fazla ${MAX_FILES_PER_UPLOAD} görsel seçebilirsin`);
      return;
    }
    setRunning(true);
    const stamp = Date.now();
    const fresh: Item[] = files.map((file, index) => {
      const thumb = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
      if (thumb) thumbs.current.push(thumb);
      return { key: `${stamp}-${index}`, name: file.name, size: file.size, thumb, phase: "hazırlanıyor" };
    });
    setItems(fresh);

    try {
      // 1) Tarayıcıda hazırla. Reddedilen görsel diğerlerini durdurmaz.
      const ready: { key: string; name: string; blob: Blob }[] = [];
      for (const [index, file] of files.entries()) {
        const prepared = await prepareAdImage(file, deps);
        const key = fresh[index].key;
        if (!prepared.ok) {
          patch(key, { phase: "reddedildi", error: prepared.error });
          continue;
        }
        ready.push({ key, name: file.name, blob: prepared.blob });
        patch(key, { phase: "yükleniyor", size: prepared.blob.size });
      }
      if (ready.length === 0) return;

      // 2) Taslaklar + imzalı PUT'lar, tek istekte (50 görsel hız sınırına çarpmasın).
      const res = await fetch("/api/portal/ads/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: ready.map((r) => ({ contentType: AD_CONTENT_TYPE, size: r.blob.size, name: r.name })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.items) || data.items.length !== ready.length) {
        const message = data.error ?? "Yükleme başlatılamadı, tekrar dene";
        ready.forEach((r) => patch(r.key, { phase: "hata", error: message }));
        return;
      }

      // 3) R2'ye doğrudan PUT, sonra sunucu doğrulaması.
      const jobs = ready.map((r, index) => ({ ...r, ...(data.items[index] as { adId: string; putUrl: string }) }));
      await pool(jobs, CONCURRENCY, async (job) => {
        try {
          const put = await fetch(job.putUrl, {
            method: "PUT",
            headers: { "Content-Type": AD_CONTENT_TYPE },
            body: job.blob,
          });
          if (!put.ok) throw new Error("put");
          patch(job.key, { phase: "tamamlanıyor" });
          const done = await fetch(`/api/portal/ads/${job.adId}/complete`, { method: "POST" });
          const body = await done.json().catch(() => ({}));
          if (!done.ok) {
            patch(job.key, { phase: "hata", error: body.error ?? "Görsel doğrulanamadı" });
            return;
          }
          patch(job.key, { phase: "bitti" });
        } catch {
          patch(job.key, { phase: "hata", error: "Bağlantı hatası, görseli yeniden seç" });
        }
      });
    } catch {
      setError("Bağlantı hatası, tekrar dene");
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  return (
    <section className="p-set" aria-labelledby="reklam-yukle">
      <h2 className="p-kicker p-kicker--accent" id="reklam-yukle">
        GÖRSEL YÜKLE
      </h2>
      <label className="p-picker" data-disabled={running ? "true" : undefined}>
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={running}
          aria-label="Reklam görseli seç"
          onChange={(e) => {
            void pick(e.target.files);
            e.target.value = "";
          }}
        />
        <span className="p-picker-badge" aria-hidden="true">
          <IconUpload size={26} />
        </span>
        <span className="p-picker-title">{running ? "Yükleniyor…" : "Galeriden görsel seç"}</span>
        <span className="p-picker-sub">
          Dikey 4:5 ya da kare · seçtiğin sırayla yayınlanır
          <span className="sr-only"> · tek seferde en fazla {MAX_FILES_PER_UPLOAD} görsel</span>
        </span>
      </label>

      {error && (
        <p className="p-note p-note--danger" role="alert">
          {error}
        </p>
      )}

      {items.length > 0 && (
        <ul className="p-list" aria-label="Reklam yüklemeleri">
          {items.map((item) => {
            const bad = item.phase === "hata" || item.phase === "reddedildi";
            return (
              <li key={item.key} className={`p-ucard${bad ? " p-ucard--error" : ""}`}>
                <div className="p-ucard-row">
                  {item.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.thumb} alt="" className="p-ucard-thumb p-ucard-thumb--img" />
                  ) : (
                    <span className="p-ucard-thumb" aria-hidden="true" />
                  )}
                  <span className="p-ucard-text">
                    <span className="p-ucard-name">{item.name}</span>
                    <span
                      className={`p-ucard-meta${bad ? " p-ucard-status--error" : ""}`}
                      role={bad ? "alert" : "status"}
                    >
                      {fileSize(item.size)} · {PHASE_TEXT[item.phase]}
                      {item.error ? `: ${item.error}` : ""}
                    </span>
                  </span>
                  {item.phase === "bitti" && (
                    <span className="p-done" aria-hidden="true">
                      <IconCheck size={16} />
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
