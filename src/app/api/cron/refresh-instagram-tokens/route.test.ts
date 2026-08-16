import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Gerçek Instagram'a ASLA çıkılmaz — yalnızca yenileme çağrısı mock'lanır,
// `IGError` gerçek sınıf olarak kalır (route hata dalında ona bakıyor).
vi.mock("@/lib/instagram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instagram")>();
  return { ...actual, refreshInstagramToken: vi.fn() };
});

import { GET } from "./route";
import { db } from "@/lib/db";
import { IGError, refreshInstagramToken } from "@/lib/instagram";
import { IG_TOKEN_REFRESH_DAYS } from "@/lib/instagram-token";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";

const mockRefresh = vi.mocked(refreshInstagramToken);

const SECRET = "test-cron-secret-en-az-otuziki-karakter-uzunlugunda";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Şu ana göre `days` gün sonrası (negatif = geçmiş). */
function inDays(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

function cronRequest(secret: string | null = SECRET) {
  return new Request("http://localhost/api/cron/refresh-instagram-tokens", {
    headers: secret === null ? {} : { Authorization: `Bearer ${secret}` },
  });
}

/** Yenileme penceresindeki (≤ 20 gün) Instagram bağlı müşteri. */
function dueClient(agencyId: string, token: string) {
  return createClient(agencyId, {
    instagramUserId: "17841400000000000",
    instagramAccessToken: token,
    instagramTokenExpiry: inDays(5),
  });
}

beforeEach(async () => {
  await resetDb();
  mockRefresh.mockReset();
  vi.stubEnv("CRON_SECRET", SECRET);
  // Log gürültüsü test çıktısını boğmasın; hata dalları yine çağrılıyor.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("yetkilendirme", () => {
  it("Authorization başlığı yoksa 401 döner ve Instagram'a hiç gidilmez", async () => {
    const res = await GET(cronRequest(null));
    expect(res.status).toBe(401);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("yanlış sır 401 döner", async () => {
    const res = await GET(cronRequest("yanlis-sir"));
    expect(res.status).toBe(401);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("CRON_SECRET tanımlı değilse doğru istek bile 401 alır", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await GET(cronRequest());
    expect(res.status).toBe(401);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("Bearer olmayan şema kabul edilmez", async () => {
    const res = await GET(
      new Request("http://localhost/api/cron/refresh-instagram-tokens", {
        headers: { Authorization: SECRET },
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("yenileme", () => {
  it("penceredeki müşterinin token'ını ve bitiş tarihini günceller", async () => {
    const agency = await createAgency();
    const client = await dueClient(agency.id, "IGAA-eski");
    const yeniBitis = inDays(60);
    mockRefresh.mockResolvedValue({ accessToken: "IGAA-yeni", expiresAt: yeniBitis });

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      checked: 1,
      refreshed: 1,
      skipped: 0,
      expired: 0,
      failed: 0,
      windowDays: IG_TOKEN_REFRESH_DAYS,
    });

    expect(mockRefresh).toHaveBeenCalledWith("IGAA-eski");
    const saved = await db.client.findUnique({ where: { id: client.id } });
    expect(saved?.instagramAccessToken).toBe("IGAA-yeni");
    expect(saved?.instagramTokenExpiry?.getTime()).toBe(yeniBitis.getTime());
  });

  it("pencerenin dışındaki müşteriye dokunmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id, {
      instagramUserId: "17841400000000000",
      instagramAccessToken: "IGAA-taze",
      instagramTokenExpiry: inDays(IG_TOKEN_REFRESH_DAYS + 5),
    });

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ checked: 1, refreshed: 0, skipped: 1 });
    expect(mockRefresh).not.toHaveBeenCalled();

    const saved = await db.client.findUnique({ where: { id: client.id } });
    expect(saved?.instagramAccessToken).toBe("IGAA-taze");
  });

  it("süresi dolmuş token yenilenmez, ayrı sayılır", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id, {
      instagramUserId: "17841400000000000",
      instagramAccessToken: "IGAA-dolmus",
      instagramTokenExpiry: inDays(-2),
    });

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ refreshed: 0, expired: 1, failed: 0 });
    expect(mockRefresh).not.toHaveBeenCalled();

    const saved = await db.client.findUnique({ where: { id: client.id } });
    expect(saved?.instagramAccessToken).toBe("IGAA-dolmus");
  });

  it("Instagram bağlı olmayan müşteri hiç sorgulanmaz", async () => {
    const agency = await createAgency();
    await createClient(agency.id);

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ checked: 0, refreshed: 0 });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("ajanslar üstü çalışır — farklı ajansların müşterileri de yenilenir", async () => {
    const agencyA = await createAgency();
    const agencyB = await createAgency();
    await dueClient(agencyA.id, "IGAA-a");
    await dueClient(agencyB.id, "IGAA-b");
    mockRefresh.mockImplementation(async (token: string) => ({
      accessToken: `${token}-yeni`,
      expiresAt: inDays(60),
    }));

    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ checked: 2, refreshed: 2, failed: 0 });
  });
});

describe("kısmi hata dayanıklılığı", () => {
  it("bir müşteri patlasa da diğerleri yenilenir", async () => {
    const agency = await createAgency();
    const first = await dueClient(agency.id, "IGAA-1");
    const broken = await dueClient(agency.id, "IGAA-2");
    const last = await dueClient(agency.id, "IGAA-3");

    mockRefresh.mockImplementation(async (token: string) => {
      if (token === "IGAA-2") {
        throw new IGError("Error validating access token", {
          error: { code: 190, type: "OAuthException" },
        });
      }
      return { accessToken: `${token}-yeni`, expiresAt: inDays(60) };
    });

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checked: 3, refreshed: 2, failed: 1 });

    // Hatalı olanın token'ı DEĞİŞMEZ, diğerleri güncellenir.
    expect((await db.client.findUnique({ where: { id: first.id } }))?.instagramAccessToken).toBe(
      "IGAA-1-yeni"
    );
    expect((await db.client.findUnique({ where: { id: broken.id } }))?.instagramAccessToken).toBe(
      "IGAA-2"
    );
    expect((await db.client.findUnique({ where: { id: last.id } }))?.instagramAccessToken).toBe(
      "IGAA-3-yeni"
    );
  });

  it("IGError olmayan beklenmedik hata da diğerlerini durdurmaz", async () => {
    const agency = await createAgency();
    await dueClient(agency.id, "IGAA-1");
    const last = await dueClient(agency.id, "IGAA-2");

    mockRefresh.mockImplementation(async (token: string) => {
      if (token === "IGAA-1") throw new TypeError("beklenmedik");
      return { accessToken: `${token}-yeni`, expiresAt: inDays(60) };
    });

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ refreshed: 1, failed: 1 });
    expect((await db.client.findUnique({ where: { id: last.id } }))?.instagramAccessToken).toBe(
      "IGAA-2-yeni"
    );
  });
});

describe("token sızıntısı", () => {
  it("yanıt ne eski ne yeni token'ı, ne de müşteri adını taşır", async () => {
    const agency = await createAgency();
    const client = await dueClient(agency.id, "IGAA-gizli-eski");
    await createClient(agency.id, {
      instagramUserId: "17841400000000000",
      instagramAccessToken: "IGAA-gizli-dolmus",
      instagramTokenExpiry: inDays(-1),
    });
    mockRefresh.mockResolvedValue({
      accessToken: "IGAA-gizli-yeni",
      expiresAt: inDays(60),
    });

    const raw = await (await GET(cronRequest())).text();

    expect(raw).not.toContain("IGAA-gizli-eski");
    expect(raw).not.toContain("IGAA-gizli-yeni");
    expect(raw).not.toContain("IGAA-gizli-dolmus");
    expect(raw).not.toContain("IGAA");
    expect(raw).not.toContain("gizli");
    expect(raw).not.toContain(client.name);
    expect(raw).not.toContain(client.id);
    expect(raw).not.toContain("instagramAccessToken");
  });

  it("hata yolunda da yanıta token düşmez", async () => {
    const agency = await createAgency();
    await dueClient(agency.id, "IGAA-gizli-eski");
    mockRefresh.mockRejectedValue(
      new IGError("token reddedildi", { error: { code: 190 }, access_token: "IGAA-gizli-eski" })
    );

    const raw = await (await GET(cronRequest())).text();
    expect(raw).not.toContain("IGAA-gizli-eski");
    expect(JSON.parse(raw)).toMatchObject({ failed: 1, refreshed: 0 });
  });
});
