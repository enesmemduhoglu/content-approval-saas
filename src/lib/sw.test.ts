import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * V7a — `public/sw.js`'in önbellek kuralı (V7-pwa §4.6, DEĞİŞMEZ):
 * `/api/**`, başka origin (R2) ve portal HTML'i ASLA önbelleğe girmez;
 * yalnızca çevrimdışı sayfası ve ikonlar.
 *
 * SW düz bir betik (paketlenmiyor), bu yüzden gerçek dosya bir `vm`
 * bağlamında, sahte `self`/`caches`/`fetch` ile koşturuluyor. Metin
 * eşleştirmesi yerine davranış: kural bozulursa hangi isteğin yanlış ele
 * alındığı doğrudan görünsün.
 */

const ORIGIN = "https://portal.example";
const source = readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8");

type Handler = (event: unknown) => void;

function loadWorker(opts: { online: boolean }) {
  const handlers: Record<string, Handler> = {};
  const store = new Map<string, Map<string, Response>>();
  const puts: string[] = [];

  const keyOf = (req: Request | string) =>
    new URL(typeof req === "string" ? req : req.url, ORIGIN).href;

  const caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const bucket = store.get(name)!;
      return {
        put: async (req: Request | string, res: Response) => {
          puts.push(new URL(keyOf(req)).pathname);
          bucket.set(keyOf(req), res);
        },
      };
    },
    match: async (req: Request | string) => {
      for (const bucket of store.values()) {
        const hit = bucket.get(keyOf(req));
        if (hit) return hit.clone();
      }
      return undefined;
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  };

  const fetchMock = vi.fn(async (input: Request | string) => {
    if (!opts.online) throw new TypeError("Failed to fetch");
    const url = new URL(typeof input === "string" ? input : input.url, ORIGIN);
    const res = new Response(`body:${url.pathname}`, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    // Tarayıcıda aynı-origin fetch yanıtı "basic"; Node'da elle kurulan
    // Response "default" döner. SW yalnızca "basic"i önbelleğe yazıyor.
    Object.defineProperty(res, "type", { value: "basic" });
    return res;
  });

  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => undefined) },
  };

  // `Request`'i kendi origin'imize göre çözecek şekilde sar (vm'de göreli URL).
  class RelRequest extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init);
    }
  }

  vm.runInNewContext(source, {
    self,
    caches,
    fetch: fetchMock,
    Request: RelRequest,
    Response,
    URL,
    Promise,
    console,
  });

  async function dispatchFetch(
    url: string,
    init: { mode?: RequestMode; method?: string } = {}
  ): Promise<Response | undefined> {
    const request = {
      url: new URL(url, ORIGIN).href,
      method: init.method ?? "GET",
      mode: init.mode ?? "cors",
    };
    let responded: Promise<Response> | undefined;
    handlers.fetch({ request, respondWith: (p: Promise<Response>) => (responded = p) });
    return responded ? await responded : undefined;
  }

  async function install() {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.install({ waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  }

  return { handlers, self, fetchMock, puts, dispatchFetch, install };
}

describe("public/sw.js — önbellek kuralı", () => {
  let w: ReturnType<typeof loadWorker>;

  beforeEach(async () => {
    w = loadWorker({ online: true });
    await w.install();
    w.puts.length = 0;
  });

  it("kurulum yalnızca çevrimdışı sayfasını ve ikonları, ÇEREZSİZ indirir", async () => {
    const fresh = loadWorker({ online: true });
    await fresh.install();
    expect(fresh.puts).toContain("/portal/cevrimdisi");
    for (const p of fresh.puts) {
      expect(p === "/portal/cevrimdisi" || p.startsWith("/icons/")).toBe(true);
    }
    for (const [req] of fresh.fetchMock.mock.calls) {
      expect((req as Request).credentials).toBe("omit");
    }
  });

  it("kurulum skipWaiting ÇAĞIRMAZ; yalnızca SKIP_WAITING mesajıyla", async () => {
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
    w.handlers.message({ data: { type: "başka" } });
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
    w.handlers.message({ data: { type: "SKIP_WAITING" } });
    expect(w.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["/api/portal/videos", "cors"],
    ["/api/portal/login/code", "cors"],
    ["https://hesap.r2.cloudflarestorage.com/clients/x/video.mp4?X-Amz-Signature=abc", "cors"],
    ["/_next/static/chunks/app.js", "no-cors"],
    ["/portal/manifest.webmanifest", "cors"],
  ] as const)("%s → SW karışmaz (respondWith yok)", async (url, mode) => {
    expect(await w.dispatchFetch(url, { mode })).toBeUndefined();
    expect(w.puts).toEqual([]);
  });

  it("GET dışı istekler (yükleme, mutasyon) hiç ele alınmaz", async () => {
    expect(await w.dispatchFetch("/portal", { method: "POST", mode: "navigate" })).toBeUndefined();
  });

  it("portal navigasyonu ağdan gelir ve önbelleğe YAZILMAZ", async () => {
    const res = await w.dispatchFetch("/portal", { mode: "navigate" });
    expect(await res?.text()).toBe("body:/portal");
    await w.dispatchFetch("/portal/video/abc", { mode: "navigate" });
    expect(w.puts).toEqual([]);
  });

  it("ikonlar önbelleğe alınabilir", async () => {
    await w.dispatchFetch("/icons/furkan-teacher/icon-192.png");
    await new Promise((r) => setTimeout(r, 0));
    expect(w.puts).toEqual(["/icons/furkan-teacher/icon-192.png"]);
  });
});

describe("public/sw.js — çevrimdışı", () => {
  it("ağ yokken navigasyon çevrimdışı sayfasını gösterir; API isteği yine karışılmaz", async () => {
    // Kurulum çevrimiçi yapıldı, sonra ağ gitti: aynı önbelleği paylaşan iki
    // aşama yerine önce kurulum, sonra fetch'i düşürüyoruz.
    const w = loadWorker({ online: true });
    await w.install();
    w.fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    const res = await w.dispatchFetch("/portal", { mode: "navigate" });
    expect(await res?.text()).toBe("body:/portal/cevrimdisi");
    expect(await w.dispatchFetch("/api/portal/videos")).toBeUndefined();
  });

  it("önbellek boşsa bile navigasyon patlamaz (503 metin)", async () => {
    const w = loadWorker({ online: false });
    const res = await w.dispatchFetch("/portal", { mode: "navigate" });
    expect(res?.status).toBe(503);
  });
});
