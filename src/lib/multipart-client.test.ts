import { describe, expect, it } from "vitest";
import {
  AbortedError,
  backoffDelay,
  FatalUploadError,
  PartPutError,
  planParts,
  remainingParts,
  resumeDecision,
  resumeKey,
  runMultipartUpload,
  RESUME_MAX_AGE_MS,
  SIGN_BATCH,
  UploadGoneError,
  URL_MAX_AGE_MS,
  type MultipartDeps,
  type MultipartStatus,
  type Readiness,
  type ResumeRecord,
} from "@/lib/multipart-client";

const MB = 1024 * 1024;
const etagOf = (n: number) => `"etag-${n}"`;
const partOf = (url: string) => Number(new URL(url).searchParams.get("n"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

type PutBehaviour = (
  partNumber: number,
  attempt: number,
  ctx: { signal: AbortSignal; url: string; onProgress: (loaded: number) => void; body: Blob }
) => Promise<string> | string;

/** Ağı, saati ve sayfa görünürlüğünü taklit eden bağımlılıklar. */
function fakeDeps(behaviour: PutBehaviour = (n) => etagOf(n)) {
  let clock = 0;
  let state: Readiness = "ready";
  let signSeq = 0;
  const signCalls: number[][] = [];
  const puts: number[] = [];
  const attempts = new Map<number, number>();
  const wakeListeners = new Set<() => void>();
  const readyWaiters: (() => void)[] = [];
  let active = 0;
  let maxActive = 0;
  let signImpl: (nums: number[]) => Promise<Map<number, string>> = async (nums) => {
    signSeq += 1;
    return new Map(nums.map((n) => [n, `https://r2.test/part?n=${n}&sig=${signSeq}`]));
  };

  const deps: MultipartDeps = {
    signParts: (nums) => {
      signCalls.push(nums);
      return signImpl(nums);
    },
    putPart: async (url, body, { signal, onProgress }) => {
      const n = partOf(url);
      const attempt = (attempts.get(n) ?? 0) + 1;
      attempts.set(n, attempt);
      puts.push(n);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await tick();
        const etag = await behaviour(n, attempt, { signal, url, onProgress, body });
        onProgress(body.size);
        return etag;
      } finally {
        active -= 1;
      }
    },
    sleep: async () => undefined,
    now: () => clock,
    readiness: () => state,
    waitUntilReady: () => new Promise<void>((resolve) => readyWaiters.push(resolve)),
    onWake: (listener) => {
      wakeListeners.add(listener);
      return () => wakeListeners.delete(listener);
    },
  };

  return {
    deps,
    signCalls,
    puts,
    attempts,
    get maxActive() {
      return maxActive;
    },
    advance(ms: number) {
      clock += ms;
    },
    setState(next: Readiness) {
      state = next;
      if (next === "ready") {
        for (const resolve of readyWaiters.splice(0)) resolve();
        for (const listener of wakeListeners) listener();
      }
    },
    wake() {
      for (const listener of wakeListeners) listener();
    },
    setSign(impl: typeof signImpl) {
      signImpl = impl;
    },
  };
}

const file = (size: number) => new Blob([new Uint8Array(size)]);

// ─── Saf yardımcılar ──────────────────────────────────────────────────────

describe("planParts", () => {
  it("1'den numaralı parçalara böler, son parça kısa kalır", () => {
    const plan = planParts(40 * MB + 123, 8 * MB);
    expect(plan).toHaveLength(6);
    expect(plan[0]).toEqual({ partNumber: 1, start: 0, end: 8 * MB });
    expect(plan[5]).toEqual({ partNumber: 6, start: 40 * MB, end: 40 * MB + 123 });
  });

  it("tam katta fazladan boş parça yok", () => {
    const plan = planParts(16 * MB, 8 * MB);
    expect(plan.map((p) => p.end - p.start)).toEqual([8 * MB, 8 * MB]);
  });

  it("boş dosya parça üretmez, geçersiz parça boyutu hata", () => {
    expect(planParts(0, 8 * MB)).toEqual([]);
    expect(() => planParts(10, 0)).toThrow();
  });
});

describe("remainingParts", () => {
  it("bitmiş parçaları atlar, sırayı korur", () => {
    const plan = planParts(5 * MB, MB);
    const left = remainingParts(plan, [
      { partNumber: 1, etag: "a" },
      { partNumber: 4, etag: "b" },
    ]);
    expect(left.map((p) => p.partNumber)).toEqual([2, 3, 5]);
  });
});

describe("backoffDelay", () => {
  it("üstel büyür, yarısı sabit yarısı rastgele", () => {
    expect(backoffDelay(1, { random: () => 0 })).toBe(500);
    expect(backoffDelay(1, { random: () => 1 })).toBe(1000);
    expect(backoffDelay(3, { random: () => 0 })).toBe(2000);
    expect(backoffDelay(3, { random: () => 1 })).toBe(4000);
  });

  it("tavanı aşmaz", () => {
    expect(backoffDelay(20, { random: () => 1, maxMs: 30_000 })).toBe(30_000);
  });
});

describe("resumeDecision", () => {
  const f = { name: "a.mov", size: 20 * MB, lastModified: 1700 };
  const record = (over: Partial<ResumeRecord> = {}): ResumeRecord => ({
    key: resumeKey(f),
    postId: "p1",
    size: f.size,
    partSize: 8 * MB,
    parts: [{ partNumber: 1, etag: '"x"' }],
    framesDone: true,
    updatedAt: 1000,
    ...over,
  });

  it("kayıt yoksa temiz başla", () => {
    expect(resumeDecision(null, f, 2000)).toEqual({ kind: "fresh", reason: "none" });
  });

  it("aynı dosyaysa kaldığı yerden", () => {
    expect(resumeDecision(record(), f, 2000)).toEqual({
      kind: "resume",
      postId: "p1",
      partSize: 8 * MB,
      parts: [{ partNumber: 1, etag: '"x"' }],
      framesDone: true,
    });
  });

  it("farklı dosya (boyut / değişiklik zamanı) temiz başlar", () => {
    expect(resumeDecision(record(), { ...f, lastModified: 1701 }, 2000).kind).toBe("fresh");
    expect(resumeDecision(record({ size: 1 }), f, 2000).kind).toBe("fresh");
  });

  it("sunucunun taslağı sildiği süreden eski kayıt temiz başlar", () => {
    expect(resumeDecision(record(), f, 1000 + RESUME_MAX_AGE_MS + 1)).toEqual({
      kind: "fresh",
      reason: "stale",
    });
  });

  it("plana uymayan parçalar atılır", () => {
    const decision = resumeDecision(
      record({
        parts: [
          { partNumber: 1, etag: '"a"' },
          { partNumber: 9, etag: '"yok"' },
          { partNumber: 2, etag: "" },
        ],
      }),
      f,
      2000
    );
    expect(decision.kind === "resume" && decision.parts).toEqual([{ partNumber: 1, etag: '"a"' }]);
  });
});

// ─── Çekirdek ─────────────────────────────────────────────────────────────

describe("runMultipartUpload", () => {
  it("bütün parçaları en fazla 3 paralel yükler, sıralı ETag listesi döner", async () => {
    const fake = fakeDeps();
    const progress: number[] = [];
    const parts = await runMultipartUpload(
      { file: file(10 * MB + 5), partSize: MB, onProgress: (f) => progress.push(f) },
      fake.deps
    );
    expect(parts.map((p) => p.partNumber)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(parts[3].etag).toBe(etagOf(4));
    expect(fake.maxActive).toBeLessThanOrEqual(3);
    expect(fake.maxActive).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(1);
  });

  it("imzaları toplu ister (≤ 20), aynı parçayı iki kez imzalatmaz", async () => {
    const fake = fakeDeps();
    await runMultipartUpload({ file: file(38 * MB), partSize: MB }, fake.deps);
    expect(fake.signCalls.every((call) => call.length <= SIGN_BATCH)).toBe(true);
    const all = fake.signCalls.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(fake.signCalls.length).toBeLessThanOrEqual(3);
  });

  it("kopan parça üstel geri çekilmeyle yeniden denenir", async () => {
    const fake = fakeDeps((n, attempt) => {
      if (n === 2 && attempt <= 2) throw new PartPutError(0, "koptu");
      return etagOf(n);
    });
    const statuses: MultipartStatus[] = [];
    const parts = await runMultipartUpload(
      { file: file(3 * MB), partSize: MB, onStatus: (s) => statuses.push(s) },
      fake.deps
    );
    expect(parts).toHaveLength(3);
    expect(fake.attempts.get(2)).toBe(3);
    expect(statuses).toContain("retrying");
  });

  it("deneme hakkı bitince hata fırlatır ve diğer parçaları durdurur", async () => {
    const fake = fakeDeps((n) => {
      if (n === 1) throw new PartPutError(500, "R2 500");
      return new Promise<string>(() => undefined); // asla bitmeyen parçalar
    });
    // Asla bitmeyen parçalar durdurmayla (AbortSignal) kesilmeli.
    const deps: MultipartDeps = {
      ...fake.deps,
      putPart: (url, body, opts) =>
        new Promise<string>((resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new AbortedError()));
          fake.deps.putPart(url, body, opts).then(resolve, reject);
        }),
    };
    await expect(
      runMultipartUpload({ file: file(5 * MB), partSize: MB, maxAttempts: 5 }, deps)
    ).rejects.toThrow("R2 500");
    expect(fake.attempts.get(1)).toBe(5);
    // Kalan parçalar (4, 5) hiç başlatılmadı.
    expect(fake.puts).not.toContain(5);
  });

  it("kaldığı yerden: bitmiş parçalar gönderilmez, ETag'leri sonuca girer", async () => {
    const fake = fakeDeps();
    const progress: number[] = [];
    const parts = await runMultipartUpload(
      {
        file: file(4 * MB),
        partSize: MB,
        done: [
          { partNumber: 1, etag: '"eski-1"' },
          { partNumber: 3, etag: '"eski-3"' },
        ],
        onProgress: (f) => progress.push(f),
      },
      fake.deps
    );
    expect(new Set(fake.puts)).toEqual(new Set([2, 4]));
    expect(parts).toEqual([
      { partNumber: 1, etag: '"eski-1"' },
      { partNumber: 2, etag: etagOf(2) },
      { partNumber: 3, etag: '"eski-3"' },
      { partNumber: 4, etag: etagOf(4) },
    ]);
    expect(progress[0]).toBe(0.5);
  });

  it("her parça bitince kayıt için tam liste bildirilir", async () => {
    const fake = fakeDeps();
    const snapshots: number[][] = [];
    await runMultipartUpload(
      {
        file: file(3 * MB),
        partSize: MB,
        concurrency: 1,
        onPartDone: (_p, all) => snapshots.push(all.map((x) => x.partNumber)),
      },
      fake.deps
    );
    expect(snapshots).toEqual([[1], [1, 2], [1, 2, 3]]);
  });

  it("R2 parçayı 404'le reddederse (yükleme iptal edilmiş) UploadGoneError, yeniden denenmez", async () => {
    const fake = fakeDeps(() => {
      throw new PartPutError(404, "NoSuchUpload");
    });
    await expect(
      runMultipartUpload({ file: file(2 * MB), partSize: MB, concurrency: 1 }, fake.deps)
    ).rejects.toBeInstanceOf(UploadGoneError);
    expect(fake.attempts.get(1)).toBe(1);
  });

  it("sunucu imzada taslağın gittiğini söylerse UploadGoneError (statüsüyle)", async () => {
    const fake = fakeDeps();
    fake.setSign(async () => {
      throw new UploadGoneError(409);
    });
    await expect(runMultipartUpload({ file: file(2 * MB), partSize: MB }, fake.deps)).rejects.toMatchObject({
      status: 409,
    });
    expect(fake.puts).toEqual([]);
  });

  it("kalıcı hata (ETag okunamıyor) yeniden denenmez", async () => {
    const fake = fakeDeps(() => {
      throw new FatalUploadError("ETag yok");
    });
    await expect(
      runMultipartUpload({ file: file(MB), partSize: MB }, fake.deps)
    ).rejects.toBeInstanceOf(FatalUploadError);
    expect(fake.attempts.get(1)).toBe(1);
  });

  it("403 (imza süresi dolmuş) → URL atılır, yenisi imzalatılır", async () => {
    const fake = fakeDeps((n, attempt, { url }) => {
      if (attempt === 1 && url.includes("sig=1")) throw new PartPutError(403, "imza");
      return etagOf(n);
    });
    await runMultipartUpload({ file: file(MB), partSize: MB }, fake.deps);
    expect(fake.signCalls).toEqual([[1], [1]]);
  });

  it("verilen taze URL'ler imza istemeden kullanılır, 10 dk'dan eskisi yenilenir", async () => {
    const fake = fakeDeps();
    await runMultipartUpload(
      { file: file(MB), partSize: MB, initialUrls: new Map([[1, "https://r2.test/part?n=1&sig=0"]]) },
      fake.deps
    );
    expect(fake.signCalls).toEqual([]);

    const later = fakeDeps((n, attempt) => {
      if (attempt === 1) {
        later.advance(URL_MAX_AGE_MS + 1);
        throw new PartPutError(0, "koptu");
      }
      return etagOf(n);
    });
    await runMultipartUpload(
      { file: file(MB), partSize: MB, initialUrls: new Map([[1, "https://r2.test/part?n=1&sig=0"]]) },
      later.deps
    );
    expect(later.signCalls).toEqual([[1]]);
  });

  it("uygulama arka plandayken düşen deneme hak yemez; görünür olunca devam eder", async () => {
    const fake = fakeDeps((n, attempt) => {
      if (attempt === 1) {
        fake.setState("hidden");
        throw new PartPutError(0, "askıya alındı");
      }
      return etagOf(n);
    });
    const statuses: MultipartStatus[] = [];
    const running = runMultipartUpload(
      { file: file(MB), partSize: MB, maxAttempts: 1, onStatus: (s) => statuses.push(s) },
      fake.deps
    );
    for (let i = 0; i < 5; i++) await tick();
    expect(statuses.at(-1)).toBe("waiting-visible");
    fake.setState("ready");
    await expect(running).resolves.toHaveLength(1);
    expect(fake.attempts.get(1)).toBe(2);
  });

  it("çevrimdışıyken bağlantı beklenir", async () => {
    const fake = fakeDeps();
    fake.setState("offline");
    const statuses: MultipartStatus[] = [];
    const running = runMultipartUpload(
      { file: file(MB), partSize: MB, onStatus: (s) => statuses.push(s) },
      fake.deps
    );
    await tick();
    expect(statuses).toContain("waiting-network");
    expect(fake.puts).toEqual([]);
    fake.setState("ready");
    await expect(running).resolves.toHaveLength(1);
  });

  it("uyanma sinyali takılmış isteği keser ve hak yemeden yeniden gönderir", async () => {
    const fake = fakeDeps((n, attempt, { signal }) => {
      if (attempt === 1) {
        // Askıdan dönen sayfadaki ölü soket: ne biter ne hata verir.
        return new Promise<string>((_, reject) =>
          signal.addEventListener("abort", () => reject(new PartPutError(0, "kesildi")))
        );
      }
      return etagOf(n);
    });
    const running = runMultipartUpload(
      { file: file(MB), partSize: MB, maxAttempts: 1, stallMs: 5_000 },
      fake.deps
    );
    for (let i = 0; i < 3; i++) await tick();
    fake.advance(6_000);
    fake.wake();
    await expect(running).resolves.toHaveLength(1);
    expect(fake.attempts.get(1)).toBe(2);
  });

  it("uyanma sinyali ilerleyen isteğe dokunmaz", async () => {
    let aborted = false;
    const fake = fakeDeps(async (n, _attempt, { signal, onProgress }) => {
      signal.addEventListener("abort", () => (aborted = true));
      onProgress(10);
      fake.wake();
      return etagOf(n);
    });
    await runMultipartUpload({ file: file(MB), partSize: MB, stallMs: 5_000 }, fake.deps);
    expect(aborted).toBe(false);
  });
});
