import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/alerts", () => ({ sendAlert: vi.fn(async () => undefined) }));

import { sendAlert } from "@/lib/alerts";
import { checkNeonUsage } from "@/lib/neon-usage";

const API_KEY = "napi_gizli_anahtar";
const fetchMock = vi.fn();
const projectWith = (cuHours: number) =>
  new Response(JSON.stringify({ project: { compute_time_seconds: cuHours * 3600 } }), { status: 200 });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(sendAlert).mockClear();
  vi.stubEnv("NEON_API_KEY", API_KEY);
  vi.stubEnv("NEON_PROJECT_ID", "proj-123");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("checkNeonUsage", () => {
  it("%69 → uyarı yok", async () => {
    fetchMock.mockResolvedValue(projectWith(69));
    expect(await checkNeonUsage()).toMatchObject({ ok: true, alerted: false });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("%71 → tek uyarı; istek doğru uca, anahtar başlıkta", async () => {
    fetchMock.mockResolvedValue(projectWith(71));

    const result = await checkNeonUsage();

    expect(result).toMatchObject({ ok: true, alerted: true, quota: 100 });
    expect(sendAlert).toHaveBeenCalledWith(
      "neon:usage",
      expect.any(String),
      expect.objectContaining({ kullanilan_cu_saat: 71, kota_cu_saat: 100, oran: "%71" })
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://console.neon.tech/api/v2/projects/proj-123");
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    // Anahtar uyarıya düşmez.
    expect(JSON.stringify(vi.mocked(sendAlert).mock.calls)).not.toContain(API_KEY);
  });

  it("NEON_CU_HOURS_QUOTA kotayı ezer", async () => {
    vi.stubEnv("NEON_CU_HOURS_QUOTA", "300");
    fetchMock.mockResolvedValue(projectWith(150));
    expect(await checkNeonUsage()).toMatchObject({ ok: true, quota: 300, alerted: false });
  });

  it("env eksikse istek atılmaz", async () => {
    vi.stubEnv("NEON_PROJECT_ID", "");
    expect(await checkNeonUsage()).toMatchObject({ ok: false, skipped: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 / 500 / ağ hatası / beklenmeyen gövde → throw etmez, ok:false", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(await checkNeonUsage()).toMatchObject({ ok: false });
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 500 }));
    expect(await checkNeonUsage()).toMatchObject({ ok: false });
    fetchMock.mockRejectedValueOnce(new Error(`bağlantı koptu ${API_KEY}`));
    expect(await checkNeonUsage()).toEqual({ ok: false, error: "istek başarısız" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ project: {} }), { status: 200 }));
    expect(await checkNeonUsage()).toMatchObject({ ok: false });
    expect(sendAlert).not.toHaveBeenCalled();
  });
});
