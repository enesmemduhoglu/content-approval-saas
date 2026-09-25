import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * CSP direktiflerinin testi.
 *
 * Neden var: `next.config.ts` build zamanı yapılandırması, hiçbir test ona
 * dokunmuyordu ve eksik bir direktif SESSİZ bir ürün hatasına dönüşüyor —
 * sayfa render olur, element çizilir, işlev çalışmaz. Deponun tarihinde bu
 * sınıftan iki olay var: `form-action` eksikken giriş bir gün kapalı kaldı
 * (17.08) ve `media-src` eksikken Reel önizlemesi oynamadı (29.08). İkisinin
 * de tek izi konsoldaki bir "Refused to..." satırıydı; telefondan bakan
 * kullanıcı onu göremez.
 *
 * Config TypeScript olduğu ve `next.config.ts`i import etmek Next'in build
 * zincirini çektiği için dosya METİN olarak okunuyor. Kaba ama bu testin
 * yakalaması gereken şey tam olarak "direktif satırı silindi/hiç yazılmadı".
 */
const config = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");

describe("Content-Security-Policy", () => {
  it("default-src kapalı tutuluyor", () => {
    expect(config).toContain('"default-src \'self\'"');
  });

  it.each([
    // direktif, neden — eksikse NE kırılır
    ["img-src", "onay sayfasındaki post görselleri (Blob + raw.githubusercontent)"],
    ["media-src", "onay sayfasındaki Reel videosu (Blob)"],
    ["form-action", "Google ile giriş (NextAuth 302'si form-action'a takılır)"],
    ["script-src", "istemci JS — hidrasyon"],
    ["style-src", "sayfa stilleri"],
  ])("%s tanımlı (eksikse: %s)", (directive) => {
    // Tırnak ya da backtick — `script-src` şablon literali (DEV_SCRIPT_SRC).
    expect(config).toMatch(new RegExp(`["\`]${directive} `));
  });

  it("dış medya https: ile açık — Blob store adı değişince sessizce kırılmasın", () => {
    // Host'u daraltmak yerine şema kısıtı: sunucu tarafında zaten allowlist var
    // (validation.ts). Aynı gerekçe img-src için de geçerli.
    expect(config).toMatch(/"img-src [^"]*https:/);
    expect(config).toMatch(/"media-src [^"]*https:/);
  });

  // Video kuyruğu (V3): portal yüklemesi tarayıcıdan doğrudan R2'ye gidiyor.
  it("connect-src R2'ye açık — portal yüklemesi tarayıcıdan bucket'a PUT eder", () => {
    expect(config).toMatch(/"connect-src 'self' [^"]*https:\/\/\*\.r2\.cloudflarestorage\.com/);
  });

  it("connect-src genel https: DEĞİL — XHR/fetch keyfi host'a gidemesin", () => {
    expect(config).not.toMatch(/"connect-src [^"]*https:[ "]/);
  });

  it("media-src blob: içerir — portal kare çıkarma seçilen dosyayı <video>'ya blob URL'le verir", () => {
    expect(config).toMatch(/"media-src [^"]*blob:/);
  });

  it("R2 imzalı GET'leri (kapak karesi, oynatıcı) img-src/media-src'deki https: kapsıyor", () => {
    expect(config).toMatch(/"img-src [^"]*https:/);
    expect(config).toMatch(/"media-src [^"]*https:/);
  });

  it("object-src ve frame-ancestors kapalı", () => {
    expect(config).toContain('"object-src \'none\'"');
    expect(config).toContain('"frame-ancestors \'none\'"');
  });

  // V7a — portal service worker'ı.
  describe("service worker ve manifest", () => {
    const register = readFileSync(
      path.join(process.cwd(), "src/components/portal/sw-register.tsx"),
      "utf8"
    );

    it("worker-src yalnızca 'self' — SW aynı kaynaktan", () => {
      expect(config).toContain('"worker-src \'self\'"');
      expect(config).toContain('"manifest-src \'self\'"');
    });

    it("blob: worker'a izin yok (ne worker-src ne de onun düştüğü script-src)", () => {
      expect(config).not.toMatch(/worker-src [^"`]*blob:/);
      expect(config).not.toMatch(/script-src [^"`]*blob:/);
    });

    it("SW kaydı aynı kaynaktaki köke bağlı bir yol (/sw.js), dış URL değil", () => {
      expect(register).toMatch(/export const SW_URL = "\/sw\.js";/);
      expect(register).toContain(".register(SW_URL,");
      // Kapsam portalla sınırlı: ajans paneli SW kontrolüne girmez.
      expect(register).toMatch(/export const SW_SCOPE = "\/portal";/);
    });

    it("SW dosyası public/ altında ve API'yi önbelleğe almıyor", () => {
      const sw = readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8");
      expect(sw).toContain('url.pathname.startsWith("/api/")');
      expect(sw).toContain("url.origin !== self.location.origin");
      // Navigasyon yanıtı önbelleğe yazılmaz: `cache.put` yalnızca kurulumda
      // ve ikon dalında geçmeli.
      expect(sw.match(/cache\.put\(/g)?.length).toBe(2);
    });
  });
});
