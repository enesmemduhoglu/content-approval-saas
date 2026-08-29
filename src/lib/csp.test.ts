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

  it("object-src ve frame-ancestors kapalı", () => {
    expect(config).toContain('"object-src \'none\'"');
    expect(config).toContain('"frame-ancestors \'none\'"');
  });
});
