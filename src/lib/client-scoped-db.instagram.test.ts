import { beforeEach, describe, expect, it } from "vitest";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";

// Portal Instagram uyarısı (2026-09-28 analizi): sorgu oturumdaki müşteriye
// kapsamlı ve dönen değerde token yok.
const now = new Date("2026-09-28T09:00:00Z");
const session = (clientId: string) => ({ clientUserId: "u", clientId });

beforeEach(async () => {
  await resetDb();
});

describe("client.instagramHealth", () => {
  it("bağlı ve süresi uzak → ok; token yanıtta yok", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id, {
      instagramUserId: "17841",
      instagramAccessToken: "IGAA-gizli",
      instagramTokenExpiry: new Date("2026-11-20T00:00:00Z"),
    });
    const health = await getClientScopedDb(session(client.id)).client.instagramHealth(now);
    expect(health).toEqual({ state: "ok" });
    expect(JSON.stringify(health)).not.toContain("IGAA");
  });

  it("başka müşterinin bağlantısı sayılmaz: kendi hesabı yoksa 'missing'", async () => {
    const agency = await createAgency();
    const mine = await createClient(agency.id);
    await createClient(agency.id, { instagramUserId: "1", instagramAccessToken: "t" });
    expect(await getClientScopedDb(session(mine.id)).client.instagramHealth(now)).toEqual({
      state: "missing",
    });
  });

  it("süresi dolmuş ve dolmak üzere", async () => {
    const agency = await createAgency();
    const expired = await createClient(agency.id, {
      instagramUserId: "1",
      instagramAccessToken: "t",
      instagramTokenExpiry: new Date("2026-09-27T00:00:00Z"),
    });
    const soon = await createClient(agency.id, {
      instagramUserId: "2",
      instagramAccessToken: "t",
      instagramTokenExpiry: new Date("2026-10-01T09:00:00Z"),
    });
    expect(await getClientScopedDb(session(expired.id)).client.instagramHealth(now)).toEqual({
      state: "expired",
    });
    expect(await getClientScopedDb(session(soon.id)).client.instagramHealth(now)).toMatchObject({
      state: "expiring",
      daysLeft: 3,
    });
  });
});
