import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu endpoint BİLEREK oturum kabul etmiyor. `auth` mock'lanıyor ki "oturum
// açıkken de çalışıyor mu" testi gerçek NextAuth'a gitmesin.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET } from "./route";
import { auth } from "@/lib/auth";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { RATE_LIMIT_MAX, resetRateLimiter } from "@/lib/rate-limit";

const API_KEY = "t".repeat(48);
const TOKEN = "IGAA-cok-gizli-token";
const IG_USER_ID = "17841400000000000";
const DAY_MS = 24 * 60 * 60 * 1000;

function tokenRequest(clientId: string, key: string | null = API_KEY) {
  return {
    request: new Request(`http://localhost/api/clients/${clientId}/instagram-token`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    }),
    context: { params: Promise.resolve({ id: clientId }) },
  };
}

function call(clientId: string, key: string | null = API_KEY) {
  const { request, context } = tokenRequest(clientId, key);
  return GET(request, context);
}

function enableApiKey(agencyId: string) {
  process.env.FURI_API_KEY = API_KEY;
  process.env.FURI_API_AGENCY_ID = agencyId;
}

/** Instagram'ı bağlı, token'ı geçerli müşteri. */
function connectedClient(agencyId: string, token = TOKEN, expiryDays = 30) {
  return createClient(agencyId, {
    instagramUserId: IG_USER_ID,
    instagramAccessToken: token,
    instagramTokenExpiry: new Date(Date.now() + expiryDays * DAY_MS),
  });
}

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  vi.mocked(auth).mockResolvedValue(null as never);
});

afterEach(() => {
  delete process.env.FURI_API_KEY;
  delete process.env.FURI_API_AGENCY_ID;
  vi.restoreAllMocks();
});

describe("yetkilendirme", () => {
  it("Authorization başlığı yoksa 401 döner", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    enableApiKey(agency.id);

    const res = await call(client.id, null);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("yanlış anahtar 401 döner", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    enableApiKey(agency.id);

    const res = await call(client.id, "x".repeat(48));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("doğru anahtarın öneki kabul edilmez", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    enableApiKey(agency.id);

    const res = await call(client.id, API_KEY.slice(0, -1));
    expect(res.status).toBe(401);
  });

  it("FURI_API_KEY tanımlı değilse endpoint tamamen kapalıdır", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    // enableApiKey çağrılmıyor.

    const res = await call(client.id);
    expect(res.status).toBe(401);
  });

  it("tarayıcı oturumu tek başına yetmez — yalnızca API anahtarı geçerli", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    vi.mocked(auth).mockResolvedValue({ agencyId: agency.id } as never);
    // API anahtarı yapılandırılmadı.

    const res = await call(client.id, null);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(TOKEN);
  });
});

describe("ajans kapsamı", () => {
  it("başka ajansın müşterisi için 404 döner, token sızmaz", async () => {
    const bizim = await createAgency();
    const baskasi = await createAgency();
    const yabanci = await connectedClient(baskasi.id, "IGAA-baska-ajans");
    enableApiKey(bizim.id);

    const res = await call(yabanci.id);
    expect(res.status).toBe(404);
    const raw = await res.text();
    expect(raw).not.toContain("IGAA-baska-ajans");
    expect(raw).not.toContain(IG_USER_ID);
    expect(JSON.parse(raw)).toMatchObject({ code: "client_not_found" });
  });

  it("olmayan müşteri ile başka ajansın müşterisi AYNI yanıtı alır", async () => {
    const bizim = await createAgency();
    const baskasi = await createAgency();
    const yabanci = await connectedClient(baskasi.id, "IGAA-baska-ajans");
    enableApiKey(bizim.id);

    const yok = await (await call("olmayan-id")).text();
    const cross = await (await call(yabanci.id)).text();
    expect(cross).toBe(yok);
  });
});

describe("token dağıtımı", () => {
  it("kendi müşterisinin token'ını ve bitiş tarihini döner", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    enableApiKey(agency.id);

    const res = await call(client.id);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      clientId: client.id,
      instagramUserId: IG_USER_ID,
      accessToken: TOKEN,
      expiresAt: client.instagramTokenExpiry?.toISOString(),
      expired: false,
    });
  });

  it("yanıt önbelleğe alınmaz", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    enableApiKey(agency.id);

    const res = await call(client.id);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("süresi dolmuş token 'expired' işaretiyle döner", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id, TOKEN, -3);
    enableApiKey(agency.id);

    const data = await (await call(client.id)).json();
    expect(data).toMatchObject({ accessToken: TOKEN, expired: true });
  });

  it("bitiş tarihi bilinmiyorsa null döner, istek yine başarılı", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id, {
      instagramUserId: IG_USER_ID,
      instagramAccessToken: TOKEN,
    });
    enableApiKey(agency.id);

    const res = await call(client.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ expiresAt: null, expired: false });
  });

  it("yanıt müşteri adını ya da e-postasını taşımaz", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    enableApiKey(agency.id);

    const raw = await (await call(client.id)).text();
    expect(raw).not.toContain(client.name);
    expect(raw).not.toContain(client.email);
  });
});

describe("rate limit (S5)", () => {
  it(`${RATE_LIMIT_MAX} istekten sonra 429 döner, token sızmaz`, async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    enableApiKey(agency.id);

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await call(client.id);
      expect(res.status).toBe(200);
    }

    const blocked = await call(client.id);
    expect(blocked.status).toBe(429);
    const raw = await blocked.text();
    expect(raw).not.toContain(TOKEN);
  });

  it("429 yanıtı da secretJson üzerinden gider — Cache-Control korunur", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    enableApiKey(agency.id);

    for (let i = 0; i < RATE_LIMIT_MAX; i++) await call(client.id);
    const blocked = await call(client.id);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("cache-control")).toContain("no-store");
  });

  it("limit aşıldığında geçersiz anahtarla gelen istek de sayılır (auth'tan önce çalışır)", async () => {
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    enableApiKey(agency.id);

    for (let i = 0; i < RATE_LIMIT_MAX; i++) await call(client.id, "x".repeat(48));
    const blocked = await call(client.id);
    expect(blocked.status).toBe(429);
  });
});

describe("erişim logu (S5)", () => {
  it("başarılı erişimde clientId + sonuç loglanır, token loglanmaz", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const agency = await createAgency();
    const client = await connectedClient(agency.id);
    enableApiKey(agency.id);

    await call(client.id);

    const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain(client.id);
    expect(logged).toContain("basarili");
    expect(logged).not.toContain(TOKEN);
    logSpy.mockRestore();
  });

  it("401/404/409 sonuçları da loglanır, token hiçbir zaman görünmez", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const agency = await createAgency();
    const notConnected = await createClient(agency.id);
    enableApiKey(agency.id);

    await call(notConnected.id, null); // 401
    await call("olmayan-id"); // 404
    await call(notConnected.id); // 409

    const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("401_yetkisiz");
    expect(logged).toContain("404_bulunamadi");
    expect(logged).toContain("409_baglanmamis");
    expect(logged).not.toContain(TOKEN);
    logSpy.mockRestore();
  });
});

describe("Instagram bağlı olmayan müşteri", () => {
  it("409 + instagram_not_connected döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    enableApiKey(agency.id);

    const res = await call(client.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "instagram_not_connected" });
  });

  it("token var ama hesap kimliği yoksa da bağlı sayılmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id, { instagramAccessToken: TOKEN });
    enableApiKey(agency.id);

    const res = await call(client.id);
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain(TOKEN);
  });
});
