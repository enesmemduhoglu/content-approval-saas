import { describe, expect, it } from "vitest";
import { checkOrigin, deriveOwnOrigin } from "./origin";

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: "POST", headers });
}

describe("deriveOwnOrigin", () => {
  it("host başlığından türetir", () => {
    expect(deriveOwnOrigin(req("http://localhost/api/posts", { host: "example.com" }))).toBe(
      "http://example.com"
    );
  });

  it("x-forwarded-host varsa host yerine onu kullanır (proxy arkasında gerçek dış host)", () => {
    expect(
      deriveOwnOrigin(
        req("http://localhost/api/posts", {
          host: "internal-service:3000",
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
        })
      )
    ).toBe("https://app.example.com");
  });

  it("hiçbir host başlığı yoksa istek URL'inden türetir", () => {
    expect(deriveOwnOrigin(req("http://localhost/api/posts"))).toBe("http://localhost");
  });

  it("preview dağıtım alan adı env'e bakmadan kendi host'undan doğru türetilir", () => {
    expect(
      deriveOwnOrigin(
        req("https://irrelevant/api/posts", {
          host: "content-approval-saas-git-foo-team.vercel.app",
          "x-forwarded-proto": "https",
        })
      )
    ).toBe("https://content-approval-saas-git-foo-team.vercel.app");
  });
});

describe("checkOrigin", () => {
  it("Origin kendi host'uyla eşleşiyorsa kabul eder", () => {
    const result = checkOrigin(
      req("http://localhost/api/posts", { host: "app.example.com", origin: "http://app.example.com" })
    );
    expect(result.ok).toBe(true);
  });

  it("yabancı Origin 403 anlamına gelen reddi döner", () => {
    const result = checkOrigin(
      req("http://localhost/api/posts", {
        host: "app.example.com",
        origin: "https://evil.example.com",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("Origin başlığı yoksa kabul eder (tarayıcı-dışı istemci, çerez zaten koruyor)", () => {
    const result = checkOrigin(req("http://localhost/api/posts", { host: "app.example.com" }));
    expect(result.ok).toBe(true);
  });

  it("preview dağıtımında kendi origin'i kendi Origin başlığıyla eşleşir", () => {
    const previewHost = "content-approval-saas-git-foo-team.vercel.app";
    const result = checkOrigin(
      req("https://irrelevant/api/posts", {
        host: previewHost,
        "x-forwarded-proto": "https",
        origin: `https://${previewHost}`,
      })
    );
    expect(result.ok).toBe(true);
  });
});
