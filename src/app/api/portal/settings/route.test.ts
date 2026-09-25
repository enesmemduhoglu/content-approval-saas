import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, portalCookie, portalRequest } from "@tests/helpers/portal";
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
  requireApproval: true,
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

    const res = await put({ ...valid, requireApproval: false, paused: true, notifyEmail: "bildirim@ornek.com" });
    expect(res.status).toBe(200);
    row = await db.publishSettings.findUniqueOrThrow({ where: { clientId } });
    expect(row).toMatchObject({ requireApproval: false, paused: true, notifyEmail: "bildirim@ornek.com" });
    expect(await db.publishSettings.count()).toBe(1);
  });

  it.each([
    ["boş slot listesi", { slots: [] }, "slots"],
    ["7 slot", { slots: ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"] }, "slots"],
    ["tekrarlı slot", { slots: ["19:00", "19:00"] }, "slots"],
    ["geçersiz saat", { slots: ["24:00"] }, "slots"],
    ["tek haneli saat", { slots: ["9:00"] }, "slots"],
    ["geçersiz saat dilimi", { timezone: "Mars/Olympus" }, "timezone"],
    ["boolean olmayan onay", { requireApproval: "evet" }, "requireApproval"],
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

  it("yabancı Origin 403", async () => {
    expect((await put(valid, "https://kotu.example")).status).toBe(403);
    expect(await db.publishSettings.count()).toBe(0);
  });
});
