import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email", () => ({
  sendRawEmail: vi.fn(),
}));

import { sendAlert } from "./alerts";
import { sendRawEmail } from "@/lib/email";

const mockSend = vi.mocked(sendRawEmail);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ALERT_EMAIL", "operator@ornek.com");
  mockSend.mockResolvedValue({ sent: true });
  // Her testte bastırma penceresini sıfırdan görmek için modülü izole
  // çalıştırıyoruz — bkz. `vi.resetModules` kullanılmadığından aynı `key`
  // testler arasında bastırma taşıyabilir, o yüzden testlerde farklı `key`
  // değerleri kullanılıyor.
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sendAlert", () => {
  it("ALERT_EMAIL'e gönderir", async () => {
    await sendAlert("test:key-1", "bir şey bozuldu");
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [payload] = mockSend.mock.calls[0];
    expect(payload.to).toBe("operator@ornek.com");
    expect(payload.subject).toContain("bir şey bozuldu");
    expect(payload.text).toContain("bir şey bozuldu");
  });

  it("ALERT_EMAIL tanımlı değilse sessizce atlar ve loglar", async () => {
    vi.stubEnv("ALERT_EMAIL", "");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendAlert("test:key-2", "bir şey bozuldu")).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("aynı key için bastırma penceresinde ikinci mail gitmez", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendAlert("test:key-3", "hata A");
    await sendAlert("test:key-3", "hata A tekrar");

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });

  it("farklı key'ler birbirini bastırmaz", async () => {
    await sendAlert("test:key-4a", "hata A");
    await sendAlert("test:key-4b", "hata B");

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("sendRawEmail throw etse bile sendAlert throw etmez", async () => {
    mockSend.mockRejectedValueOnce(new Error("resend patladı"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendAlert("test:key-5", "hata")).resolves.toBeUndefined();

    consoleErrorSpy.mockRestore();
  });

  it("detail alanları gövdeye eklenir ve uzunluk kırpılır", async () => {
    await sendAlert("test:key-6", "başlık", { postId: "abc123", uzun: "x".repeat(500) });
    const [payload] = mockSend.mock.calls[0];
    expect(payload.text).toContain("postId: abc123");
    // 300 karakterden uzun olmamalı (MAX_DETAIL_VALUE_LEN kırpması)
    const uzunSatir = payload.text.split("\n").find((line: string) => line.startsWith("uzun:"));
    expect(uzunSatir!.length).toBeLessThanOrEqual("uzun: ".length + 300);
  });
});
