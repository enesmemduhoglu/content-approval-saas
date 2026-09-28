import { describe, expect, it } from "vitest";
import { classifyPublishError, errorCodes, explainPublishError } from "./portal-publish-error";

// Saf — DB yok. Girdiler `IGError.report()` ve `publish-post`un gerçekte
// yazdığı biçimde.
describe("errorCodes", () => {
  it("report() biçiminden code ve error_subcode'u okur, fbtrace'i değil", () => {
    expect(errorCodes("Bir şey · type=OAuthException · code=9 · error_subcode=2207051 · fbtrace_id=A12")).toEqual([
      9, 2207051,
    ]);
  });

  it("container durum metnindeki 'error code N'yi okur", () => {
    expect(errorCodes("Container c1 durumu ERROR: Media upload has failed with error code 2207026")).toEqual([
      2207026,
    ]);
  });

  it("kodsuz metinde boş", () => {
    expect(errorCodes("Instagram API'ye ulaşılamadı (POST /me/media): fetch failed")).toEqual([]);
  });
});

describe("classifyPublishError", () => {
  it.each([
    ["Error validating access token · type=OAuthException · code=190 · error_subcode=460", "auth"],
    ["Instagram erişim token'ının süresi dolmuş — ajansın yenilemesi gerekiyor", "auth"],
    ["Application request limit reached · type=OAuthException · code=4", "limit"],
    ["Too many calls · code=9 · error_subcode=2207042", "limit"],
    ["Action is blocked · code=9 · error_subcode=2207051", "restricted"],
    ["Container c1 durumu ERROR: Media upload has failed with error code 2207026", "format"],
    ["The aspect ratio is not supported · code=36003", "format"],
    ["Video indirilemedi · code=9004 · fbtrace_id=Afb", "fetch"],
    ["Media download has timed out · code=-2 · error_subcode=2207003", "fetch"],
    ["Instagram API'ye ulaşılamadı (POST /me/media_publish): fetch failed", "temporary"],
    ["Container c1 ayrılan sürede hazır olmadı (son durum: IN_PROGRESS)", "temporary"],
    ["Video container'ının 24 saatlik ömrü doldu — yayın tekrar denenmeli", "temporary"],
    ["Instagram API HTTP 502 döndü (POST /me/media)", "temporary"],
    ["An unexpected error has occurred · code=2", "temporary"],
    ["Instagram token'ı sunucuda çözülemedi (ENCRYPTION_KEY sorunu)", "server"],
    ["Media ID is not available", "unknown"],
  ])("%s → %s", (raw, kind) => {
    expect(classifyPublishError(raw)).toBe(kind);
  });

  it("alt kod ana koddan önce gelir: code=9 + 2207051 kısıtlama, sınır değil", () => {
    expect(classifyPublishError("code=4 · error_subcode=2207051")).toBe("restricted");
  });
});

describe("explainPublishError", () => {
  it("boş/eski kayıt: genel metin, ayrıntı yok", () => {
    const view = explainPublishError(null);
    expect(view.kind).toBe("unknown");
    expect(view.title).toBe("Instagram’a yayınlanamadı");
    expect(view.raw).toBe("");
  });

  it("biçim hatası: tekrar denemek boşuna, ham metin ayrıntıda", () => {
    const raw = "Container c1 durumu ERROR: Media upload has failed with error code 2207026";
    const view = explainPublishError(raw);
    expect(view.retryUseless).toBe(true);
    expect(view.raw).toBe(raw);
    expect(view.todo).toContain("yeniden yükle");
  });

  it("geçici hatalarda tekrar denemek işe yarar", () => {
    for (const raw of ["code=4", "code=9004", "code=190", "fetch failed ulaşılamadı"]) {
      expect(explainPublishError(raw).retryUseless).toBe(false);
    }
  });
});
