// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PushToggle, urlBase64ToUint8Array } from "./push-toggle";

/**
 * V7c — `PushToggle`: iPhone kuralları (ana ekran, dokunuşla izin, reddedilmiş
 * izin) ve açma/kapama akışı. `Notification`, `serviceWorker`, `PushManager`
 * ve `fetch` taklit; asıl push servisine hiçbir şey gitmez.
 */

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const ENDPOINT = "https://web.push.apple.com/cihaz";
const PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

type Sub = {
  endpoint: string;
  toJSON: () => unknown;
  unsubscribe: ReturnType<typeof vi.fn>;
};

let currentSub: Sub | null;
let permission: NotificationPermission;
const requestPermission = vi.fn();
const subscribe = vi.fn();
const fetchMock = vi.fn();
const order: string[] = [];

function makeSub(): Sub {
  return {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(async () => {
      currentSub = null;
      return true;
    }),
  };
}

function setEnv(opts: { ua?: string; standalone?: boolean; push?: boolean; sw?: boolean } = {}) {
  Object.defineProperty(navigator, "userAgent", { value: opts.ua ?? IPHONE_UA, configurable: true });
  Object.defineProperty(navigator, "standalone", { value: opts.standalone ?? true, configurable: true });
  Object.defineProperty(navigator, "platform", { value: "iPhone", configurable: true });

  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => currentSub),
      subscribe,
    },
  };
  if (opts.sw === false) {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  } else {
    Object.defineProperty(navigator, "serviceWorker", {
      value: { ready: Promise.resolve(registration) },
      configurable: true,
    });
  }
  if (opts.push === false) {
    delete (window as { PushManager?: unknown }).PushManager;
  } else {
    Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true });
  }
  vi.stubGlobal(
    "Notification",
    Object.assign(function Notification() {}, {
      get permission() {
        return permission;
      },
      requestPermission,
    })
  );
}

function apiResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  currentSub = null;
  permission = "default";
  order.length = 0;
  requestPermission.mockReset();
  requestPermission.mockImplementation(async () => {
    order.push("izin");
    permission = "granted";
    return "granted";
  });
  subscribe.mockReset();
  subscribe.mockImplementation(async () => {
    currentSub = makeSub();
    return currentSub;
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    order.push(`fetch:${init?.method ?? "GET"}`);
    if (!init?.method) return apiResponse({ publicKey: PUBLIC_KEY, subscribed: false });
    return apiResponse({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const toggle = () => screen.getByRole("switch", { name: "Telefon bildirimleri" }) as HTMLButtonElement;

async function readyToggle() {
  await waitFor(() => expect(toggle().disabled).toBe(false));
  return toggle();
}

describe("PushToggle — durumlar", () => {
  it("başlık, alt metin ve erişilebilir anahtar", async () => {
    setEnv();
    render(<PushToggle />);
    expect(screen.getByText("Yayınlandı, yayınlanamadı, onay bekleyen videolar.")).toBeTruthy();
    const sw = await readyToggle();
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("iPhone Safari sekmesi (ana ekranda değil) → 'önce ana ekrana ekle', anahtar pasif, ağ yok", async () => {
    setEnv({ standalone: false, push: false });
    render(<PushToggle />);
    expect(await screen.findByText("Önce ana ekrana ekle (Paylaş → Ana Ekrana Ekle).")).toBeTruthy();
    expect(toggle().disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("izin reddedilmiş → iPhone Ayarlar notu, anahtar pasif", async () => {
    permission = "denied";
    setEnv();
    render(<PushToggle />);
    expect(await screen.findByText("Bildirim izni kapalı — iPhone Ayarlar'dan aç.")).toBeTruthy();
    expect(toggle().disabled).toBe(true);
  });

  it("destek yok (masaüstü, PushManager yok) → açıklama", async () => {
    setEnv({ ua: DESKTOP_UA, push: false });
    render(<PushToggle />);
    expect(await screen.findByText("Bu tarayıcı telefon bildirimlerini desteklemiyor.")).toBeTruthy();
    expect(toggle().disabled).toBe(true);
  });

  it("sunucuda VAPID yoksa (publicKey null) → kullanılamıyor, anahtar pasif", async () => {
    setEnv();
    fetchMock.mockImplementation(async () => apiResponse({ publicKey: null, subscribed: false }));
    render(<PushToggle />);
    expect(await screen.findByText("Bildirimler şu an kullanılamıyor.")).toBeTruthy();
    expect(toggle().disabled).toBe(true);
  });

  it("cihaz aboneyse endpoint BAŞLIKLA sorulur (sorgu dizgisinde değil); kayıtlıysa açık görünür", async () => {
    permission = "granted";
    currentSub = makeSub();
    setEnv();
    fetchMock.mockImplementation(async () => apiResponse({ publicKey: PUBLIC_KEY, subscribed: true }));
    render(<PushToggle />);
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/push");
    expect((init.headers as Record<string, string>)["x-push-endpoint"]).toBe(ENDPOINT);
  });
});

describe("PushToggle — açma / kapama", () => {
  it("açma: izin dokunuşta İLK istenir, sonra subscribe + POST", async () => {
    setEnv();
    render(<PushToggle />);
    const sw = await readyToggle();
    order.length = 0;

    fireEvent.click(sw);
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));

    expect(order[0]).toBe("izin");
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(PUBLIC_KEY),
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(post![1].body)).toEqual({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } });
  });

  it("izin reddedilirse abone olunmaz, not gösterilir", async () => {
    setEnv();
    requestPermission.mockImplementation(async () => {
      permission = "denied";
      return "denied";
    });
    render(<PushToggle />);
    fireEvent.click(await readyToggle());
    expect(await screen.findByText("Bildirim izni kapalı — iPhone Ayarlar'dan aç.")).toBeTruthy();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("sunucu kaydetmezse yeni abonelik geri alınır, hata gösterilir, anahtar kapalı kalır", async () => {
    setEnv();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? apiResponse({ error: "x" }, 500)
        : apiResponse({ publicKey: PUBLIC_KEY, subscribed: false })
    );
    render(<PushToggle />);
    fireEvent.click(await readyToggle());
    expect((await screen.findByRole("alert")).textContent).toContain("açılamadı");
    expect(currentSub).toBeNull();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("kapama: önce DELETE, sonra cihazda unsubscribe", async () => {
    permission = "granted";
    currentSub = makeSub();
    const sub = currentSub;
    setEnv();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      order.push(`fetch:${init?.method ?? "GET"}`);
      return init?.method ? apiResponse({ ok: true }) : apiResponse({ publicKey: PUBLIC_KEY, subscribed: true });
    });
    sub.unsubscribe.mockImplementation(async () => {
      order.push("unsubscribe");
      currentSub = null;
      return true;
    });
    render(<PushToggle />);
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    order.length = 0;

    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(order).toEqual(["fetch:DELETE", "unsubscribe"]);
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(JSON.parse(del![1].body)).toEqual({ endpoint: ENDPOINT });
  });
});

describe("urlBase64ToUint8Array", () => {
  it("VAPID public anahtarı 65 baytlık P-256 noktasına çözülür", () => {
    const bytes = urlBase64ToUint8Array(PUBLIC_KEY);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });
});
