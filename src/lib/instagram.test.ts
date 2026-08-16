import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IGError,
  fetchInstagramAccount,
  publishToInstagram,
  refreshInstagramToken,
} from "./instagram";

/**
 * Instagram'a gerçek istek atılmaz; `fetch` mock'lanıp çağrı sırası
 * doğrulanır — Python referansındaki (ig_yayinla.py) akışın aynısı beklenir.
 */

type Call = { url: string; method: string; params: URLSearchParams };
let calls: Call[] = [];

/** Sıradaki isteğe verilecek yanıtlar; her çağrı bir tanesini tüketir. */
let responses: (() => { status?: number; body: unknown })[] = [];

function respond(body: unknown, status = 200) {
  return () => ({ status, body });
}

function mockFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const params =
      method === "POST"
        ? (init!.body as URLSearchParams)
        : new URL(url).searchParams;
    calls.push({ url: url.split("?")[0], method, params });

    const next = responses.shift();
    if (!next) throw new Error(`Beklenmeyen fetch çağrısı: ${method} ${url}`);
    const { status = 200, body } = next();
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal("fetch", mockFetch());
  // Date de sahte olmalı: bekleme bütçesi Date.now() ile ölçülüyor, sadece
  // setTimeout ilerletmek bütçeyi ilerletmez.
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const INPUT = {
  igUserId: "17841400000000000",
  accessToken: "IGAA-test-token",
  caption: "Merhaba dünya",
};

describe("publishToInstagram — tek görsel", () => {
  it("media → media_publish → permalink sırasını izler", async () => {
    responses = [
      respond({ id: "container-1" }), // POST /media
      respond({ status_code: "FINISHED" }), // GET container
      respond({ id: "media-1" }), // POST /media_publish
      respond({ id: "media-1", permalink: "https://instagram.com/p/ABC/" }), // GET media
    ];

    const result = await publishToInstagram({
      ...INPUT,
      imageUrls: ["https://raw.githubusercontent.com/x/1.jpg"],
      altTexts: ["Bir kedi"],
    });

    expect(result).toEqual({
      mediaId: "media-1",
      permalink: "https://instagram.com/p/ABC/",
    });
    expect(calls.map((c) => `${c.method} ${c.url.split("/v23.0/")[1]}`)).toEqual([
      "POST 17841400000000000/media",
      "GET container-1",
      "POST 17841400000000000/media_publish",
      "GET media-1",
    ]);
    expect(calls[0].params.get("image_url")).toBe(
      "https://raw.githubusercontent.com/x/1.jpg"
    );
    expect(calls[0].params.get("caption")).toBe("Merhaba dünya");
    expect(calls[0].params.get("alt_text")).toBe("Bir kedi");
    expect(calls[0].params.get("is_carousel_item")).toBeNull();
    expect(calls[2].params.get("creation_id")).toBe("container-1");
  });

  it("permalink alınamazsa yayın yine de başarılı sayılır", async () => {
    responses = [
      respond({ id: "container-1" }),
      respond({ status_code: "FINISHED" }),
      respond({ id: "media-1" }),
      respond({ error: { message: "geçici hata" } }, 500),
    ];

    const result = await publishToInstagram({
      ...INPUT,
      imageUrls: ["https://raw.githubusercontent.com/x/1.jpg"],
    });
    expect(result.mediaId).toBe("media-1");
    expect(result.permalink).toBe("");
  });
});

describe("publishToInstagram — karusel", () => {
  it("her slayt için child container açar, hepsini bekler, sonra CAROUSEL yayınlar", async () => {
    responses = [
      respond({ id: "child-1" }),
      respond({ id: "child-2" }),
      respond({ id: "child-3" }),
      respond({ status_code: "FINISHED" }), // child-1
      respond({ status_code: "FINISHED" }), // child-2
      respond({ status_code: "FINISHED" }), // child-3
      respond({ id: "carousel-1" }),
      respond({ status_code: "FINISHED" }), // carousel
      respond({ id: "media-9" }),
      respond({ id: "media-9", permalink: "https://instagram.com/p/XYZ/" }),
    ];

    const result = await publishToInstagram({
      ...INPUT,
      imageUrls: [
        "https://raw.githubusercontent.com/x/1.jpg",
        "https://raw.githubusercontent.com/x/2.jpg",
        "https://raw.githubusercontent.com/x/3.jpg",
      ],
    });

    expect(result.mediaId).toBe("media-9");

    const creates = calls.filter((c) => c.url.endsWith("/media") && c.method === "POST");
    expect(creates).toHaveLength(4); // 3 slayt + 1 karusel
    expect(creates[0].params.get("is_carousel_item")).toBe("true");
    // Slayt container'larında caption olmaz — caption yalnızca karuselde
    expect(creates[0].params.get("caption")).toBeNull();

    const carousel = creates[3];
    expect(carousel.params.get("media_type")).toBe("CAROUSEL");
    expect(carousel.params.get("children")).toBe("child-1,child-2,child-3");
    expect(carousel.params.get("caption")).toBe("Merhaba dünya");
  });

  it("10'dan fazla görsel API'ye hiç gitmeden reddedilir", async () => {
    await expect(
      publishToInstagram({
        ...INPUT,
        imageUrls: Array.from({ length: 11 }, (_, i) => `https://raw.githubusercontent.com/x/${i}.jpg`),
      })
    ).rejects.toBeInstanceOf(IGError);
    expect(calls).toHaveLength(0);
  });
});

describe("container bekleme", () => {
  it("FINISHED olana kadar yoklar, sonra yayınlar", async () => {
    responses = [
      respond({ id: "container-1" }),
      respond({ status_code: "IN_PROGRESS" }),
      respond({ status_code: "IN_PROGRESS" }),
      respond({ status_code: "FINISHED" }),
      respond({ id: "media-1" }),
      respond({ id: "media-1", permalink: "https://instagram.com/p/A/" }),
    ];

    const promise = publishToInstagram({
      ...INPUT,
      imageUrls: ["https://raw.githubusercontent.com/x/1.jpg"],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toMatchObject({ mediaId: "media-1" });

    const polls = calls.filter((c) => c.method === "GET" && c.url.endsWith("container-1"));
    expect(polls).toHaveLength(3);
  });

  it("container ERROR durumuna düşerse yayınlamaz", async () => {
    responses = [
      respond({ id: "container-1" }),
      respond({ status_code: "ERROR", status: "Görsel indirilemedi" }),
    ];

    await expect(
      publishToInstagram({
        ...INPUT,
        imageUrls: ["https://raw.githubusercontent.com/x/1.jpg"],
      })
    ).rejects.toThrow(/ERROR/);
    // media_publish çağrılmamalı
    expect(calls.some((c) => c.url.includes("media_publish"))).toBe(false);
  });

  it("bütçe dolunca bekleme kesilir ve yayın yapılmaz", async () => {
    responses = [respond({ id: "container-1" }), ...Array.from({ length: 30 }, () => respond({ status_code: "IN_PROGRESS" }))];

    const promise = publishToInstagram({
      ...INPUT,
      imageUrls: ["https://raw.githubusercontent.com/x/1.jpg"],
      budgetMs: 5_000,
    });
    const assertion = expect(promise).rejects.toThrow(/hazır olmadı/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(calls.some((c) => c.url.includes("media_publish"))).toBe(false);
  });
});

describe("hata sarmalama", () => {
  it("Meta'nın hata JSON'unu IGError içinde korur", async () => {
    responses = [
      respond(
        {
          error: {
            message: "Invalid OAuth access token",
            type: "OAuthException",
            code: 190,
            error_subcode: 463,
            fbtrace_id: "AbCdEf",
          },
        },
        401
      ),
    ];

    const error = await publishToInstagram({
      ...INPUT,
      imageUrls: ["https://raw.githubusercontent.com/x/1.jpg"],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IGError);
    const igError = error as IGError;
    expect(igError.message).toBe("Invalid OAuth access token");
    expect(igError.http).toBe(401);
    expect(igError.report()).toContain("code=190");
    expect(igError.report()).toContain("fbtrace_id=AbCdEf");
  });

  it("ağ hatası da IGError'a sarılır", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      })
    );

    await expect(
      publishToInstagram({
        ...INPUT,
        imageUrls: ["https://raw.githubusercontent.com/x/1.jpg"],
      })
    ).rejects.toBeInstanceOf(IGError);
  });
});

describe("refreshInstagramToken", () => {
  const SIXTY_DAYS_SEC = 60 * 24 * 3600;

  it("yeni token'ı ve expires_in'den hesaplanan bitiş tarihini döner", async () => {
    responses = [
      respond({
        access_token: "IGAA-yeni-token",
        token_type: "bearer",
        expires_in: SIXTY_DAYS_SEC,
      }),
    ];

    const result = await refreshInstagramToken("IGAA-eski-token");

    expect(result.accessToken).toBe("IGAA-yeni-token");
    expect(result.expiresAt.getTime()).toBe(Date.now() + SIXTY_DAYS_SEC * 1000);
  });

  it("sürümsüz refresh_access_token uç noktasını doğru parametrelerle çağırır", async () => {
    responses = [respond({ access_token: "IGAA-yeni-token", expires_in: SIXTY_DAYS_SEC })];

    await refreshInstagramToken("IGAA-eski-token");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    // Yenileme uç noktası Graph'ın sürümlü ağacında DEĞİL, host kökünde.
    expect(calls[0].url).toBe("https://graph.instagram.com/refresh_access_token");
    expect(calls[0].url).not.toContain("/v23.0/");
    expect(calls[0].params.get("grant_type")).toBe("ig_refresh_token");
    expect(calls[0].params.get("access_token")).toBe("IGAA-eski-token");
  });

  it("Instagram token'ı reddederse IGError fırlatır", async () => {
    responses = [
      respond(
        {
          error: {
            message: "Error validating access token: Session has expired",
            type: "OAuthException",
            code: 190,
          },
        },
        400
      ),
    ];

    const error = await refreshInstagramToken("IGAA-dolmus-token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IGError);
    expect((error as IGError).report()).toContain("code=190");
  });

  it("yanıtta access_token yoksa IGError fırlatır", async () => {
    responses = [respond({ token_type: "bearer", expires_in: SIXTY_DAYS_SEC })];
    await expect(refreshInstagramToken("IGAA-eski-token")).rejects.toBeInstanceOf(IGError);
  });

  it("expires_in geçersizse IGError fırlatır ve token'ı hata ayrıntısına koymaz", async () => {
    responses = [respond({ access_token: "IGAA-yeni-token", expires_in: "sonsuz" })];

    const error = await refreshInstagramToken("IGAA-eski-token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IGError);
    // Hata ayrıntısı log'a/DB'ye düşebiliyor — ham token ASLA içinde olmamalı.
    expect(JSON.stringify((error as IGError).detail)).not.toContain("IGAA-yeni-token");
  });

  it("ağ hatası da IGError'a sarılır", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      })
    );

    await expect(refreshInstagramToken("IGAA-eski-token")).rejects.toBeInstanceOf(IGError);
  });
});

describe("fetchInstagramAccount", () => {
  it("GET /me çağırır ve hesap kimliğini döner", async () => {
    responses = [respond({ user_id: "17841400000000000", username: "test_hesap" })];

    const account = await fetchInstagramAccount("IGAA-test-token");

    expect(account).toEqual({ userId: "17841400000000000", username: "test_hesap" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.split("/v23.0/")[1]).toBe("me");
    expect(calls[0].params.get("fields")).toBe("user_id,username");
    expect(calls[0].params.get("access_token")).toBe("IGAA-test-token");
  });

  it("geçersiz token'da IGError fırlatır", async () => {
    responses = [respond({ error: { message: "Invalid OAuth access token", code: 190 } }, 401)];

    await expect(fetchInstagramAccount("bozuk-token")).rejects.toBeInstanceOf(IGError);
  });

  it("yanıtta hesap kimliği yoksa IGError fırlatır", async () => {
    responses = [respond({ username: "test_hesap" })];

    await expect(fetchInstagramAccount("IGAA-test-token")).rejects.toBeInstanceOf(IGError);
  });
});
