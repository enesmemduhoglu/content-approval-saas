import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { ESKI_HOST, eskiAdresYonlendirmeleri } from "./eski-adres";

/**
 * Kaynak kalıplarını Next'in KENDİ eşleştiricisiyle sınıyoruz: regex'i elle
 * yorumlamak, path-to-regexp'in kök yol ve negatif ileri bakış davranışını
 * yanlış tahmin etmeye açık. Asıl risk `/api/**`'nin yönlendirilmesi — furi
 * ve QStash sessizce kırılırdı.
 */
function yonlenir(kurallar: ReturnType<typeof eskiAdresYonlendirmeleri>, yol: string) {
  return kurallar.some((k) => getPathMatch(k.source, { removeUnnamedParams: true, strict: true })(yol) !== false);
}

describe("eskiAdresYonlendirmeleri", () => {
  const kurallar = eskiAdresYonlendirmeleri("https://portal.example.com/");

  it("APP_URL yok, bozuk ya da eski hostsa kural üretmez", () => {
    expect(eskiAdresYonlendirmeleri(undefined)).toEqual([]);
    expect(eskiAdresYonlendirmeleri("")).toEqual([]);
    expect(eskiAdresYonlendirmeleri("bozuk adres")).toEqual([]);
    expect(eskiAdresYonlendirmeleri(`https://${ESKI_HOST}`)).toEqual([]);
  });

  it("her kural yalnızca eski hostta, geçici yönlendirmeyle çalışır", () => {
    expect(kurallar.length).toBeGreaterThan(0);
    for (const k of kurallar) {
      expect(k.has).toEqual([{ type: "host", value: ESKI_HOST }]);
      expect(k.permanent).toBe(false);
      expect(k.destination.startsWith("https://portal.example.com/")).toBe(true);
    }
  });

  it.each(["/", "/portal", "/portal/kuyruk", "/portal/giris", "/approve/abc123", "/dashboard"])(
    "sayfa yolu yönlendirilir: %s",
    (yol) => expect(yonlenir(kurallar, yol)).toBe(true)
  );

  it.each([
    "/api/queue/tick",
    "/api/posts",
    "/api/auth/callback/google",
    "/api/clients/x/instagram-token",
    "/_next/static/chunks/main.js",
    "/sw.js",
  ])("yönlendirilmez: %s", (yol) => expect(yonlenir(kurallar, yol)).toBe(false));

  it("yol hedefe aynen taşınır", () => {
    const kural = kurallar.find((k) => k.source !== "/")!;
    const params = getPathMatch(kural.source, { removeUnnamedParams: true, strict: true })("/approve/abc123");
    expect(params).toEqual({ path: "approve/abc123" });
    expect(kural.destination).toBe("https://portal.example.com/:path");
  });
});
