import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@upstash/qstash", async () => (await import("@tests/helpers/qstash")).qstashModule());
import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, portalCookie, portalRequest } from "@tests/helpers/portal";
import { qstashMock, resetQstashMock } from "@tests/helpers/qstash";
import { GET, PUT } from "./route";

let clientId: string;
let clientEmail: string;
let cookie: string;

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  const agency = await createAgency();
  const client = await createClient(agency.id);
  clientId = client.id;
  clientEmail = client.email;
  cookie = portalCookie(await createClientUser(client.id));
});

const valid = {
  slots: ["19:00"],
  timezone: "Europe/Istanbul",
  paused: false,
  notifyEmail: null,
};

const put = (body: unknown, origin?: string) =>
  PUT(portalRequest("/api/portal/settings", { method: "PUT", cookie, body, origin }));

describe("GET /api/portal/settings", () => {
  it("satır yoksa varsayılanları döner ama YAZMAZ (tick yalnızca ayarı olanı tarar)", async () => {
    const res = await GET(portalRequest("/api/portal/settings", { cookie }));
    const data = await res.json();
    expect(data).toMatchObject({ saved: false, settings: valid, defaultNotifyEmail: clientEmail });
    expect(await db.publishSettings.count()).toBe(0);
  });

  it("oturumsuz 401", async () => {
    expect((await GET(portalRequest("/api/portal/settings"))).status).toBe(401);
  });
});

describe("PUT /api/portal/settings", () => {
  it("ilk kayıtta satırı oluşturur, sonra günceller; slotlar sıralı saklanır", async () => {
    expect((await put({ ...valid, slots: ["21:30", "09:00"] })).status).toBe(200);
    let row = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(row.slots).toEqual(["09:00", "21:30"]);

    const res = await put({ ...valid, paused: true, notifyEmail: "bildirim@ornek.com" });
    expect(res.status).toBe(200);
    row = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(row).toMatchObject({ paused: true, notifyEmail: "bildirim@ornek.com" });
    expect(await db.publishSettings.count()).toBe(1);
  });

  it("K33: eski PWA'nın gönderdiği requireApproval (geçersiz olsa da) yok sayılır, yanıtta yok", async () => {
    const res = await put({ ...valid, requireApproval: "evet", paused: true });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.settings).not.toHaveProperty("requireApproval");
    const row = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(row.paused).toBe(true);
  });

  it.each([
    ["boş slot listesi", { slots: [] }, "slots"],
    ["7 slot", { slots: ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"] }, "slots"],
    ["tekrarlı slot", { slots: ["19:00", "19:00"] }, "slots"],
    ["geçersiz saat", { slots: ["24:00"] }, "slots"],
    ["tek haneli saat", { slots: ["9:00"] }, "slots"],
    ["geçersiz saat dilimi", { timezone: "Mars/Olympus" }, "timezone"],
    ["boolean olmayan duraklatma", { paused: 1 }, "paused"],
    ["geçersiz e-posta", { notifyEmail: "adres-degil" }, "notifyEmail"],
  ])("%s → 400 (field: %s)", async (_label, patch, field) => {
    const res = await put({ ...valid, ...patch });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe(field);
    expect(await db.publishSettings.count()).toBe(0);
  });

  it("6 slot kabul, IANA saat dilimi (America/New_York) kabul", async () => {
    const res = await put({
      ...valid,
      slots: ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"],
      timezone: "America/New_York",
    });
    expect(res.status).toBe(200);
  });

  it("GET varsayılanı tüm günler; ilk kayıtta days gönderilmezse şema varsayılanı yazılır", async () => {
    const res = await GET(portalRequest("/api/portal/settings", { cookie }));
    expect((await res.json()).settings.days).toEqual([1, 2, 3, 4, 5, 6, 7]);

    expect((await put(valid)).status).toBe(200);
    const row = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(row.days).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("yayın günleri sıralanarak saklanır ve yanıtta döner", async () => {
    const res = await put({ ...valid, days: [5, 1, 4] });
    expect(res.status).toBe(200);
    expect((await res.json()).settings.days).toEqual([1, 4, 5]);
    const row = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(row.days).toEqual([1, 4, 5]);
  });

  it("days alanı gönderilmezse mevcut seçim KORUNUR (eski istemci her güne çevirmesin)", async () => {
    await put({ ...valid, days: [1] });
    const res = await put({ ...valid, slots: ["09:30"] });
    expect(res.status).toBe(200);
    const row = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(row).toMatchObject({ days: [1], slots: ["09:30"] });
  });

  it.each([
    ["boş gün listesi", []],
    ["dizi olmayan", "1,2"],
    ["null", null],
    ["0", [0, 1]],
    ["8", [1, 8]],
    ["tekrarlı gün", [1, 1]],
    ["kesirli gün", [1.5]],
    ["metin gün", ["1"]],
  ])("days: %s → 400 (field: days), mevcut değer değişmez", async (_label, days) => {
    await put({ ...valid, days: [2, 3] });
    const res = await put({ ...valid, days });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("days");
    const row = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(row.days).toEqual([2, 3]);
  });

  it("yabancı Origin 403", async () => {
    expect((await put(valid, "https://kotu.example")).status).toBe(403);
    expect(await db.publishSettings.count()).toBe(0);
  });
});

describe("PUT → slot uyandırmaları (V11)", () => {
  beforeEach(() => {
    resetQstashMock();
    vi.stubEnv("QSTASH_TOKEN", "test-token");
    vi.stubEnv("APP_URL", "https://cas.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const wakeTimes = async () =>
    (await db.queueWake.findMany({ orderBy: { at: "asc" } })).map((w) => w.at.getTime());

  it("başarılı kayıttan sonra yeni saatlerin uyandırmaları kurulur", async () => {
    expect((await put({ ...valid, slots: ["09:00", "20:00"] })).status).toBe(200);

    const times = await wakeTimes();
    // 6 günlük ufuk × 2 slot (bugünün geçmiş olanları hariç).
    expect(times.length).toBeGreaterThanOrEqual(11);
    expect(qstashMock.published).toHaveLength(times.length);
    expect(qstashMock.published.every((p) => (p.body as { kind: string }).kind === "slot")).toBe(true);
    // Kurulum paralel — sıraya değil kümeye bak.
    expect(qstashMock.published.map((p) => p.notBefore! * 1000).sort((a, b) => a - b)).toEqual(times);
  });

  it("saat değişince eski uyandırmalar iptal edilir", async () => {
    await put({ ...valid, slots: ["09:00"] });
    const before = await wakeTimes();
    await put({ ...valid, slots: ["10:00"] });

    expect(qstashMock.cancelled).toHaveLength(before.length);
    const after = await wakeTimes();
    expect(after.some((t) => before.includes(t))).toBe(false);
  });

  it("uyandırma kurulamasa da kayıt 200 ve ayar yazılmış", async () => {
    qstashMock.failPublishAfter = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await put({ ...valid, slots: ["21:30"] });

    expect(res.status).toBe(200);
    const row = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(row.slots).toEqual(["21:30"]);
    expect(await db.queueWake.count()).toBe(0);
  });

  it("doğrulama hatasında (400) senkron hiç koşmaz", async () => {
    expect((await put({ ...valid, slots: ["25:99"] })).status).toBe(400);
    expect(qstashMock.published).toEqual([]);
    expect(await db.queueWake.count()).toBe(0);
  });
});
