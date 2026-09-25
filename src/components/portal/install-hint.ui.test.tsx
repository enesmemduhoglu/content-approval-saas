// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { INSTALL_HINT_KEY, InstallHint, shouldShowInstallHint, type InstallEnv } from "./install-hint";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

const env = (overrides: Partial<InstallEnv> = {}): InstallEnv => ({
  userAgent: IPHONE_SAFARI,
  maxTouchPoints: 5,
  navigatorStandalone: false,
  displayModeStandalone: false,
  dismissed: false,
  ...overrides,
});

describe("shouldShowInstallHint", () => {
  it("iPhone Safari, tarayıcı sekmesinde → göster", () => {
    expect(shouldShowInstallHint(env())).toBe(true);
  });

  it("ana ekrandan açılmışsa (standalone) → gösterme", () => {
    expect(shouldShowInstallHint(env({ navigatorStandalone: true }))).toBe(false);
    expect(shouldShowInstallHint(env({ displayModeStandalone: true }))).toBe(false);
  });

  it("kapatıldıysa → gösterme", () => {
    expect(shouldShowInstallHint(env({ dismissed: true }))).toBe(false);
  });

  it("iOS'ta Safari olmayan tarayıcı ve Android → gösterme", () => {
    expect(shouldShowInstallHint(env({ userAgent: IPHONE_CHROME }))).toBe(false);
    expect(shouldShowInstallHint(env({ userAgent: ANDROID_CHROME }))).toBe(false);
  });

  it("iPad masaüstü kimliğiyle gelse de dokunmatikse → göster; gerçek Mac → gösterme", () => {
    expect(shouldShowInstallHint(env({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 }))).toBe(true);
    expect(shouldShowInstallHint(env({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0 }))).toBe(false);
  });
});

describe("InstallHint", () => {
  beforeEach(() => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(IPHONE_SAFARI);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("iPhone Safari'de bant çıkar; Kapat'a basınca gider ve localStorage'a yazılır", () => {
    render(<InstallHint />);
    expect(screen.getByText(/Paylaş → Ana Ekrana Ekle/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Kapat" }));
    expect(screen.queryByText(/Paylaş → Ana Ekrana Ekle/)).toBeNull();
    expect(window.localStorage.getItem(INSTALL_HINT_KEY)).toBe("1");
  });

  it("daha önce kapatıldıysa hiç çıkmaz", () => {
    window.localStorage.setItem(INSTALL_HINT_KEY, "1");
    render(<InstallHint />);
    expect(screen.queryByText(/Paylaş → Ana Ekrana Ekle/)).toBeNull();
  });

  it("depolama erişimi hata verirse bant yine çalışır (çökmeden)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    render(<InstallHint />);
    fireEvent.click(screen.getByRole("button", { name: "Kapat" }));
    expect(screen.queryByText(/Paylaş → Ana Ekrana Ekle/)).toBeNull();
  });

  it("masaüstü tarayıcıda çıkmaz", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ANDROID_CHROME);
    render(<InstallHint />);
    expect(screen.queryByText(/Paylaş → Ana Ekrana Ekle/)).toBeNull();
  });
});
