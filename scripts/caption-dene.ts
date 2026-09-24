/**
 * Caption hattını (Whisper → Claude → doğrulama) yerel bir videoyla ELLE dener.
 * DB'ye ve R2'ye DOKUNMAZ: video ve kareler fal'ın geçici deposuna yüklenir,
 * sonuç yalnızca ekrana yazılır. Amaç prompt'u ve dış servis sözleşmesini
 * (fal'ın mp4/mov kabul edip etmediği, Claude'un URL'den kare okuyabilmesi)
 * gerçek bir videoyla görmek — birim testleri bunları mock'luyor.
 *
 * Çalıştırma (`@/` takma adları için vitest yapılandırması kullanılıyor):
 *
 *   npx vite-node --config vitest.config.ts scripts/caption-dene.ts <video> [--not "daha kısa"] [--kare 6]
 *
 * Anahtarlar: ortamda `FAL_KEY` / `ANTHROPIC_API_KEY` yoksa
 * `../subtitle-pipeline/.env`ten (ya da `CAPTION_DENE_ENV` yolundan) okunur.
 * Değerleri hiçbir koşulda yazdırılmaz. Kareler için PATH'te ffmpeg/ffprobe
 * gerekir; yoksa yalnızca transkriptle denenir.
 *
 * Maliyet: bir Whisper çağrısı + bir ya da iki Claude çağrısı (birkaç sent).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFalClient } from "@fal-ai/client";
import { transcribe } from "@/lib/caption/transcribe";
import { CAPTION_MODEL, generateCaption } from "@/lib/caption/generate";
import { InvalidModelOutputError } from "@/lib/caption/errors";
import { validateDraft } from "@/lib/caption/validate";

// Ana repo `visual studio/` altında, worktree'ler bir kat daha derinde.
const DEFAULT_ENVS = [
  path.resolve(process.cwd(), "..", "subtitle-pipeline", ".env"),
  path.resolve(process.cwd(), "..", "..", "subtitle-pipeline", ".env"),
];
const STYLE_DOC = path.resolve(process.cwd(), "docs", "video-kuyrugu", "caption-stili.md");

function parseArgs(argv: string[]) {
  const args = { video: "", note: undefined as string | undefined, frames: 6 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--not") args.note = argv[++i];
    else if (a === "--kare") args.frames = Number(argv[++i]);
    else if (!args.video) args.video = a;
  }
  return args;
}

/** Yalnızca eksik anahtarları doldurur; değer hiçbir yerde loglanmaz. */
function loadKeys(): void {
  const envPath =
    process.env.CAPTION_DENE_ENV ?? DEFAULT_ENVS.find((p) => existsSync(p)) ?? DEFAULT_ENVS[0];
  const wanted = ["FAL_KEY", "ANTHROPIC_API_KEY"].filter((k) => !process.env[k]);
  if (wanted.length === 0) return;
  if (!existsSync(envPath)) throw new Error(`Anahtar dosyası yok: ${envPath}`);
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (!m || !wanted.includes(m[1])) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  for (const k of wanted) {
    console.log(`  ${k}: ${process.env[k] ? "yüklendi" : "BULUNAMADI"}`);
  }
}

/** caption-stili.md'nin "Talimat" bölümü — `Client.captionStyle`ın kaynağı. */
function readStyle(): string {
  const doc = readFileSync(STYLE_DOC, "utf8");
  const start = doc.indexOf("## Talimat");
  if (start < 0) throw new Error("caption-stili.md'de Talimat bölümü yok");
  const body = doc.slice(doc.indexOf("\n", start) + 1);
  const end = body.search(/^## /m);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Portaldaki tarayıcı çıkarımının yerel eşi: süreye eşit aralıklı N kare. */
function extractFrames(video: string, count: number, dir: string): string[] {
  const duration = Number(
    execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video,
    ]).toString().trim()
  );
  const files: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = (duration * (i + 0.5)) / count;
    const out = path.join(dir, `${i}.jpg`);
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "4", "-y", out],
      { stdio: "ignore" }
    );
    files.push(out);
  }
  return files;
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".jpg": "image/jpeg",
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.video || !existsSync(args.video)) {
    console.error("Kullanım: vite-node --config vitest.config.ts scripts/caption-dene.ts <video> [--not \"...\"] [--kare 6]");
    process.exit(1);
  }
  console.log("Anahtarlar:");
  loadKeys();
  const fal = createFalClient({ credentials: process.env.FAL_KEY });
  const upload = async (file: string) => {
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return fal.storage.upload(new Blob([readFileSync(file)], { type }));
  };

  const t0 = Date.now();
  const since = () => `${((Date.now() - t0) / 1000).toFixed(1)} sn`;

  console.log(`\nVideo yükleniyor: ${path.basename(args.video)}`);
  const videoUrl = await upload(args.video);
  console.log(`  yüklendi (${since()})`);

  let frameUrls: string[] = [];
  if (args.frames > 0 && hasFfmpeg()) {
    const dir = mkdtempSync(path.join(tmpdir(), "caption-dene-"));
    try {
      const files = extractFrames(args.video, args.frames, dir);
      frameUrls = await Promise.all(files.map(upload));
      console.log(`  ${frameUrls.length} kare yüklendi (${since()})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    console.log("  kare yok (ffmpeg bulunamadı ya da --kare 0)");
  }

  console.log("\nWhisper (fal-ai/whisper)...");
  const tw = Date.now();
  const transcript = await transcribe(videoUrl);
  console.log(`  ${((Date.now() - tw) / 1000).toFixed(1)} sn, ${transcript.chunks.length} parça`);
  console.log(`  transkript: ${transcript.text || "(boş)"}`);

  const captionStyle = readStyle();
  let problems: string[] | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    console.log(`\nClaude (${CAPTION_MODEL}), deneme ${attempt}...`);
    const tc = Date.now();
    let raw: unknown;
    try {
      raw = await generateCaption({
        frameUrls,
        transcript: transcript.text,
        captionStyle,
        note: args.note,
        previousProblems: problems,
      });
    } catch (error) {
      if (!(error instanceof InvalidModelOutputError)) throw error;
      problems = [error.message];
      console.log(`  çözülemeyen çıktı: ${error.message}`);
      continue;
    }
    console.log(`  ${((Date.now() - tc) / 1000).toFixed(1)} sn`);
    const checked = validateDraft(raw);
    if (!checked.ok) {
      problems = checked.problems;
      console.log(`  doğrulamadan geçmedi:\n    - ${checked.problems.join("\n    - ")}`);
      continue;
    }
    console.log("\n──────── Post.caption ────────");
    console.log(checked.caption);
    console.log("──────── altText (saklanmıyor) ────────");
    console.log(checked.draft.altText);
    console.log("───────────────────────────────");
    console.log(
      `${checked.caption.length} karakter, ${checked.draft.hashtagler.length} hashtag, toplam ${since()}`
    );
    return;
  }
  console.log("\nSONUÇ: failed — iki deneme de doğrulamadan geçmedi.");
  process.exitCode = 2;
}

main().catch((error) => {
  // Hata nesnesinin tamamı değil yalnızca mesajı: SDK hataları istek
  // ayrıntısı taşıyabilir.
  console.error("Hata:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
