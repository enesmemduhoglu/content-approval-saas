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

  // V7c: bildirim testleri için pencere listesi dışarıdan doldurulur.
  const windows: FakeWindow[] = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    skipWaiting: vi.fn(),
    registration: {
      showNotification: vi.fn(async (_title: string, _options: Record<string, unknown>) => undefined),
    },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async (_url: string) => null),
    },
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

  /** `waitUntil`'e verilen işi bekler — bildirim dinleyicileri async. */
  async function dispatch(type: string, event: Record<string, unknown>) {
    let pending: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  }

  return { handlers, self, fetchMock, puts, dispatchFetch, install, dispatch, windows };
}

type FakeWindow = {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
};

function fakeWindow(url: string): FakeWindow {
  const win: FakeWindow = {
    url: new URL(url, ORIGIN).href,
    focus: vi.fn(async () => win),
    navigate: vi.fn(async (to: string) => {
      win.url = to;
      return win;
    }),
  };
  return win;
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

describe("public/sw.js — bildirimler (V7c)", () => {
  const pushEvent = (payload: unknown) => ({
    data:
      typeof payload === "string"
        ? { json: () => JSON.parse(payload), text: () => payload }
        : { json: () => payload, text: () => JSON.stringify(payload) },
  });

  it("push → başlık, gövde, ikon, etiket ve data.url ile bildirim gösterir", async () => {
    const w = loadWorker({ online: true });
    await w.dispatch(
      "push",
      pushEvent({
        title: "Videon yayınlandı",
        body: "İlk satır",
        url: "https://www.instagram.com/reel/abc/",
        tag: "yayin-sonucu",
        icon: "/icons/furkan-teacher/icon-192.png",
      })
    );
    expect(w.self.registration.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = w.self.registration.showNotification.mock.calls[0];
    expect(title).toBe("Videon yayınlandı");
    expect(options).toMatchObject({
      body: "İlk satır",
      icon: "/icons/furkan-teacher/icon-192.png",
      tag: "yayin-sonucu",
      data: { url: "https://www.instagram.com/reel/abc/" },
    });
    // Rozet payload'da yoksa hiç konmaz (renkli ikon Android'de beyaz kare olurdu).
    expect(options).not.toHaveProperty("badge");
    // Bildirim önbelleğe hiçbir şey yazmaz.
    expect(w.puts).toEqual([]);
  });

  it.each([
    ["dış site", "https://evil.example/portal"],
    ["javascript:", "javascript:alert(1)"],
    ["protokolsüz dış adres", "//evil.example/portal"],
    ["portal dışı yol", "/dashboard"],
    ["http Instagram", "http://www.instagram.com/reel/x/"],
    ["benzer alan adı", "https://instagram.com.evil.example/"],
  ])("push → güvensiz URL (%s) portala düşer", async (_label, url) => {
    const w = loadWorker({ online: true });
    await w.dispatch("push", pushEvent({ title: "x", body: "y", url, icon: "https://evil.example/i.png" }));
    const [, options] = w.self.registration.showNotification.mock.calls[0];
    expect((options.data as { url: string }).url).toBe(`${ORIGIN}/portal`);
    expect(options.icon).toBe("/icons/varsayilan/icon-192.png");
  });

  it("push → JSON olmayan veri de bildirim olarak gösterilir (iOS sessiz push'u cezalandırır)", async () => {
    const w = loadWorker({ online: true });
    await w.dispatch("push", {
      data: {
        json: () => {
          throw new SyntaxError("JSON değil");
        },
        text: () => "düz metin",
      },
    });
    const [title, options] = w.self.registration.showNotification.mock.calls[0];
    expect(title).toBe("Yeni bildirim");
    expect(options.body).toBe("düz metin");
  });

  const clickEvent = (url: unknown) => {
    const close = vi.fn();
    return { event: { notification: { close, data: { url } } }, close };
  };

  it("notificationclick → açık portal penceresi odaklanır ve hedefe gider; yeni pencere AÇILMAZ", async () => {
    const w = loadWorker({ online: true });
    const win = fakeWindow("/portal/gecmis");
    w.windows.push(win);
    const { event, close } = clickEvent(`${ORIGIN}/portal/video/abc`);
    await w.dispatch("notificationclick", event);
    expect(close).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.navigate).toHaveBeenCalledWith(`${ORIGIN}/portal/video/abc`);
    expect(w.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("notificationclick → portal penceresi yoksa yeni pencere açar", async () => {
    const w = loadWorker({ online: true });
    w.windows.push(fakeWindow("/dashboard")); // ajans paneli portal değil
    const { event } = clickEvent(`${ORIGIN}/portal`);
    await w.dispatch("notificationclick", event);
    expect(w.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/portal`);
  });

  it("notificationclick → Instagram linki yeni pencerede; portal penceresi yerinde kalır", async () => {
    const w = loadWorker({ online: true });
    const win = fakeWindow("/portal");
    w.windows.push(win);
    const { event } = clickEvent("https://www.instagram.com/reel/abc/");
    await w.dispatch("notificationclick", event);
    expect(w.self.clients.openWindow).toHaveBeenCalledWith("https://www.instagram.com/reel/abc/");
    expect(win.navigate).not.toHaveBeenCalled();
  });

  it("notificationclick → data'daki güvensiz URL açılmaz, portala düşer", async () => {
    const w = loadWorker({ online: true });
    const { event } = clickEvent("https://evil.example/");
    await w.dispatch("notificationclick", event);
    expect(w.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/portal`);
  });
});
