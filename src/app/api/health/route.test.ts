import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";
import { db } from "@/lib/db";
import { resetDb } from "@tests/helpers/db";

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("DB erişilebilirken 200 ve sadece { status: 'ok' } döner", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("DB erişilemezken 503 döner, hata ayrıntısı sızmaz", async () => {
    // `vi.spyOn` yerine doğrudan property ataması: Prisma client'ın
    // `$queryRaw`ı internal olarak proxy/getter tabanlı olabiliyor ve
    // spyOn+restoreAllMocks bazı ortamlarda metodu kalıcı olarak bozuyor
    // (diğer testleri etkiliyor). Doğrudan atayıp `finally`de elle geri
    // koymak testler arası sızıntıyı garanti önler.
    const original = db.$queryRaw;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).$queryRaw = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused: host=secret-db-host user=admin"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ status: "error" });
      // Yanıt gövdesi ham hata metnini İÇERMEMELİ — public/kimliksiz uç nokta.
      expect(JSON.stringify(body)).not.toContain("secret-db-host");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).$queryRaw = original;
      consoleErrorSpy.mockRestore();
    }
  });

  it("yanıt gövdesi sürüm, sayaç ya da env adı gibi envanter bilgisi taşımaz", async () => {
    const res = await GET();
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["status"]);
  });
});
