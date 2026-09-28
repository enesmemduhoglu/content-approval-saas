"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  MAX_FILES,
  STATUS_TEXT,
  useVideoUpload,
  type ItemPhase,
  type ItemState,
} from "@/components/portal/use-video-upload";
import { IconAlert, IconCheck, IconCopy, IconUpload } from "@/components/portal/icons";
import { duplicatePlace, duplicateSentence, skippedText } from "@/lib/portal-duplicate";

const PHASE_LABEL: Record<ItemPhase, string> = {
  bekliyor: "Sırada",
  hazırlanıyor: "Kareler çıkarılıyor…",
  soruluyor: "Kararını bekliyor",
  atlandı: "Yüklenmedi",
  yükleniyor: "Yükleniyor…",
  tamamlanıyor: "Kuyruğa ekleniyor…",
  bitti: "Kuyruğa eklendi · caption hazırlanıyor",
  hata: "Yüklenemedi",
};

const ACCEPT = "video/mp4,video/quicktime";

/** Bağlantı/görünürlük bekleyen yükleme: kart turuncuya döner (maket). */
const WAITING = new Set<string>(Object.values(STATUS_TEXT));

/**
 * Büyük videoda ondalık gürültü; 1 MB altında "0,0 MB" yanıltıcı — KB.
 * Ondalık ayırıcı Türkçe virgül (Ayarlar'daki depolama göstergesiyle aynı).
 */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const value = bytes / (1024 * 1024);
  return value >= 10 ? `${Math.round(value)} MB` : `${value.toFixed(1).replace(".", ",")} MB`;
}

/** Kartın solundaki kutu: kare çıkarıldıysa ilk kare, yoksa düz renk. */
function Thumb({ item, className }: { item: ItemState; className: string }) {
  return item.thumb ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={item.thumb} alt="" className={`${className} p-ucard-thumb--img`} />
  ) : (
    <span className={className} aria-hidden="true" />
  );
}

type Decide = (key: string, upload: boolean) => void;

/**
 * "Aynı video" (V7 tasarımı, 28 Eyl (3)): dosya daha önce yüklenmiş
 * görünüyor; yüklenmeden önce sorulur. Diğer dosyalar bu arada yüklenir.
 */
function DuplicateCard({ item, decide }: { item: ItemState; decide: Decide }) {
  const match = item.duplicate!;
  return (
    <li className="p-ucard p-ucard--waiting">
      <div className="p-ucard-row">
        <Thumb item={item} className="p-ucard-thumb" />
        <span className="p-ucard-text">
          <span className="p-ucard-name">{item.name}</span>
          <span className="p-ucard-meta">
            {fileSize(item.size)} · {PHASE_LABEL.soruluyor.toLocaleLowerCase("tr")}
          </span>
        </span>
      </div>
      <div className="p-dup" role="status">
        <IconCopy size={18} />
        <span className="p-dup-text">
          <strong>Bu video zaten yüklenmiş olabilir</strong>
          <span>
            {duplicateSentence(match)} ·{" "}
            <Link href={`/portal/video/${match.id}`}>{duplicatePlace(match)}</Link>
          </span>
        </span>
      </div>
      <div className="p-dup-actions">
        <button type="button" className="p-btn p-btn--outline" onClick={() => decide(item.key, false)}>
          Yükleme
        </button>
        <button type="button" className="p-btn p-btn--primary" onClick={() => decide(item.key, true)}>
          Yine de yükle
        </button>
      </div>
    </li>
  );
}

function SkippedCard({ item, undoSkip }: { item: ItemState; undoSkip: (key: string) => void }) {
  return (
    <li className="p-ucard p-ucard--skipped">
      <div className="p-ucard-row">
        <Thumb item={item} className="p-ucard-thumb" />
        <span className="p-ucard-text">
          <span className="p-ucard-name">{item.name}</span>
          <span className="p-ucard-meta" role="status">
            {item.duplicate ? skippedText(item.duplicate) : PHASE_LABEL.atlandı}
          </span>
        </span>
        <button type="button" className="p-textbtn" onClick={() => undoSkip(item.key)}>
          Geri al
        </button>
      </div>
    </li>
  );
}

function UploadCard({ item }: { item: ItemState }) {
  if (item.phase === "bitti") {
    return (
      <li className="p-ucard">
        <div className="p-ucard-row">
          <Thumb item={item} className="p-ucard-thumb" />
          <span className="p-ucard-text">
            <span className="p-ucard-name">{item.name}</span>
            <span className="p-ucard-meta" role="status">
              {PHASE_LABEL.bitti}
            </span>
          </span>
          <span className="p-done" aria-hidden="true">
            <IconCheck size={16} />
          </span>
        </div>
        {item.note && <p className="p-ucard-note">{item.note}</p>}
      </li>
    );
  }

  const failed = item.phase === "hata";
  const waiting = !failed && item.status !== undefined && WAITING.has(item.status);
  const pct = Math.round(item.progress * 100);
  const showPct = item.phase === "yükleniyor" || item.phase === "tamamlanıyor";
  // Hook'un anlık durumu ("Devam ediyor…", "Bağlantı bekleniyor") varsa o;
  // yoksa aşamanın adı.
  const statusText = failed
    ? `${PHASE_LABEL.hata}${item.error ? `: ${item.error}` : ""}`
    : (item.status ?? PHASE_LABEL[item.phase]);

  return (
    <li className={`p-ucard${waiting ? " p-ucard--waiting" : ""}${failed ? " p-ucard--error" : ""}`}>
      <div className="p-ucard-row">
        <Thumb
          item={item}
          className={`p-ucard-thumb${waiting ? " p-ucard-thumb--waiting" : ""}${failed ? " p-ucard-thumb--error" : ""}`}
        />
        <span className="p-ucard-text">
          <span className="p-ucard-name">{item.name}</span>
          <span className="p-ucard-meta">{fileSize(item.size)}</span>
        </span>
        {showPct && <span className="p-ucard-pct">%{pct}</span>}
      </div>
      {!failed && (
        <div
          className="p-progress"
          role="progressbar"
          aria-label={`${item.name} yükleme ilerlemesi`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div
            className={`p-progress-fill${waiting ? " p-progress-fill--waiting" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <p
        className={`p-ucard-status${waiting ? " p-ucard-status--waiting" : ""}${failed ? " p-ucard-status--error" : ""}`}
        role={failed ? "alert" : "status"}
      >
        {statusText}
      </p>
      {item.note && <p className="p-ucard-note">{item.note}</p>}
    </li>
  );
}

/**
 * Çoklu video yükleme ekranı. Akışın mantığı (taslak, tek PUT / çok parçalı
 * yükleme, kaldığı yerden devam, ekran kilidi) `use-video-upload.ts`'te; bu
 * bileşen yalnızca görünüm (V7 mobil tasarımı).
 */
export function UploadForm() {
  const router = useRouter();
  // Seçim yüklemeyi hemen başlatır (ayrı "Yükle" düğmesi yok). Hata alanlar
  // yeniden seçerek devam eder (hook'un kaldığı yerden devamı).
  const { items, running, error, doneCount, pick, decide, undoSkip } = useVideoUpload({
    onFinished: () => router.refresh(),
  });

  return (
    <>
      <label className="p-picker" data-disabled={running ? "true" : undefined}>
        <input
          type="file"
          accept={ACCEPT}
          multiple
          disabled={running}
          onChange={(e) => {
            pick(e.target.files);
            // Aynı dosyanın yeniden seçilebilmesi için (kaldığı yerden devam
            // yolu tam olarak bunu istiyor) alan sıfırlanır; dosyalar hook'ta.
            e.target.value = "";
          }}
        />
        <span className="p-picker-badge" aria-hidden="true">
          <IconUpload size={26} />
        </span>
        <span className="p-picker-title">{running ? "Yükleniyor…" : "Galeriden video seç"}</span>
        <span className="p-picker-sub">
          Seçince hemen yüklenir · en fazla 90 sn, 300 MB
          <span className="sr-only"> · tek seferde en fazla {MAX_FILES} video</span>
        </span>
      </label>

      <p className="p-note p-note--warn">
        <IconAlert size={18} />
        <span>
          Yükleme sürerken uygulamadan çıkarsan durur; geri dönünce <strong>kaldığı yerden</strong>{" "}
          devam eder.
        </span>
      </p>

      {error && (
        <p className="p-note p-note--danger" role="alert">
          {error}
        </p>
      )}

      {items.length > 0 && (
        <ul className="p-list" aria-label="Yüklemeler">
          {items.map((item) =>
            item.phase === "soruluyor" && item.duplicate ? (
              <DuplicateCard key={item.key} item={item} decide={decide} />
            ) : item.phase === "atlandı" ? (
              <SkippedCard key={item.key} item={item} undoSkip={undoSkip} />
            ) : (
              <UploadCard key={item.key} item={item} />
            )
          )}
        </ul>
      )}

      <div className="p-bottom">
        {doneCount > 0 && !running && (
          <Link href="/portal" className="p-btn p-btn--outline p-btn--block">
            Kuyruğa git
          </Link>
        )}
        <p className="p-hint">
          Caption&apos;lar yüklemeden sonra birkaç dakikada hazırlanır; video kırpılmaz, olduğu gibi
          yayınlanır.
        </p>
      </div>
    </>
  );
}
