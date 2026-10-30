import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/alerts", () => ({ sendAlert: vi.fn(async () => undefined) }));

import { sendAlert } from "@/lib/alerts";
import { NEON_QUOTA_ALERT_KEY, isUnreachableDbError, probeNeon, reportCrash } from "@/lib/db-health";

const NEON_URL = "postgresql://kullanici:gizli-sifre@ep-test-123-pooler.us-east-1.aws.neon.tech/neondb";
const QUOTA_BODY = JSON.stringify({
  message: "Your account or project has exceeded the quota. Upgrade your plan to increase limits.",
});
const unreachable = () =>
  new Error("Invalid `prisma.publishSettings.findMany()` invocation:\n\nCan't reach database server at `x:5432`");

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(sendAlert).mockClear();
  vi.stubEnv("DATABASE_URL", NEON_URL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Mock'a giden her şey + oluşan uyarılar — sır taşımamalı. */
const everythingSent = () =>
  JSON.stringify([vi.mocked(sendAlert).mock.calls, fetchMock.mock.calls.map((c) => c[0])]);

describe("probeNeon", () => {
  it("402 + 'exceeded the quota' → quota_exceeded", async () => {
    fetchMock.mockResolvedValue(new Response(QUOTA_BODY, { status: 402 }));
    expect(await probeNeon()).toBe("quota_exceeded");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ep-test-123-pooler.us-east-1.aws.neon.tech/sql");
    // Bağlantı adresi yalnızca Neon'un kendi başlığında gider.
    expect(init.headers["Neon-Connection-String"]).toBe(NEON_URL);
  });

  it("200 → reachable", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await probeNeon()).toBe("reachable");
  });

  it("ağ hatası ya da başka bir durum → unknown, throw etmez", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    expect(await probeNeon()).toBe("unknown");
    fetchMock.mockResolvedValue(new Response("x", { status: 500 }));
    expect(await probeNeon()).toBe("unknown");
  });

  it("Neon olmayan (yerel) adreste hiç istek atmaz", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5455/x");
    expect(await probeNeon()).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("yerelde POSTGRES_URL prod'u gösterse de uygulamanın DB'si (DATABASE_URL) esas — prod yoklanmaz", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5455/x");
    vi.stubEnv("POSTGRES_URL", NEON_URL);
    expect(await probeNeon()).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isUnreachableDbError", () => {
  it("P1001 sınıflarını ve metnini tanır, başka hatayı tanımaz", () => {
    expect(isUnreachableDbError(new Prisma.PrismaClientInitializationError("x", "6", "P1001"))).toBe(true);
    expect(isUnreachableDbError(unreachable())).toBe(true);
    expect(isUnreachableDbError(new Error("unique constraint"))).toBe(false);
    expect(isUnreachableDbError("string")).toBe(false);
  });
});

describe("reportCrash", () => {
  it("DB'ye ulaşılamıyor + kota doldu → genel uyarı yerine tek kota uyarısı", async () => {
    fetchMock.mockResolvedValue(new Response(QUOTA_BODY, { status: 402 }));

    await reportCrash("queue:tick:crash", "Kuyruk tick'i çöktü", unreachable());

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(
      NEON_QUOTA_ALERT_KEY,
      expect.stringContaining("Neon kotası doldu"),
      expect.objectContaining({ kaynak: "queue:tick:crash" })
    );
    expect(everythingSent()).not.toContain("gizli-sifre");
  });

  it("DB'ye ulaşılamıyor ama kota değil → eski genel uyarı", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await reportCrash("cron:x:crash", "x çöktü", unreachable());

    expect(sendAlert).toHaveBeenCalledWith("cron:x:crash", "x çöktü", {
      error: expect.stringContaining("Can't reach database server"),
    });
  });

  it("başka bir hata → Neon yoklanmaz, genel uyarı", async () => {
    await reportCrash("cron:x:crash", "x çöktü", new Error("bambaşka"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith("cron:x:crash", "x çöktü", { error: "bambaşka" });
  });

  it("yoklama patlasa da throw etmez, genel uyarıya düşer", async () => {
    fetchMock.mockImplementation(() => {
      throw new Error("senkron patlama");
    });
    await expect(reportCrash("k", "t", unreachable())).resolves.toBeUndefined();
    expect(sendAlert).toHaveBeenCalledWith("k", "t", expect.any(Object));
  });
});
