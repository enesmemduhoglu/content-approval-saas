import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import {
  CLIENT_SESSION_COOKIE,
  CLIENT_SESSION_RENEW_BELOW_SECONDS,
  CLIENT_SESSION_TTL_SECONDS,
  signClientSession,
  verifyClientSession,
} from "@/lib/client-auth";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, portalRequest } from "@tests/helpers/portal";
import { POST as renew } from "./route";

/**
 * V7a — kaydırmalı oturum (K25). Çerez "şu kadar gün önce" imzalanmış gibi
 * kuruluyor: `signClientSession`'a geçmiş bir `now` veriliyor.
 */
const DAY = 24 * 60 * 60 * 1000;

let user: { id: string; clientId: string };

function cookieIssuedDaysAgo(days: number): string {
  const { value } = signClientSession(
    { clientUserId: user.id, clientId: user.clientId },
    new Date(Date.now() - days * DAY)
  );
  return `${CLIENT_SESSION_COOKIE}=${value}`;
}

const req = (cookie?: string, origin?: string) =>
  portalRequest("/api/portal/session", { method: "POST", cookie, origin });

function cookieValue(res: Response): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0].split("=").slice(1).join("=");
}

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  const agency = await createAgency();
  const client = await createClient(agency.id);
  user = await createClientUser(client.id);
});

describe("POST /api/portal/session — kaydırmalı yenileme", () => {
  it("taze çerez (kalan > 15 gün) yenilenmez, Set-Cookie yok", async () => {
    const res = await renew(req(cookieIssuedDaysAgo(1)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.renewed).toBe(false);
    expect(res.headers.get("set-cookie")).toBeNull();
    // Bir sonraki kontrol: bitiş − 15 gün ≈ imzadan 15 gün sonra.
    const renewAt = Date.parse(body.renewAt);
    expect(renewAt).toBeGreaterThan(Date.now() + 13 * DAY);
    expect(renewAt).toBeLessThan(Date.now() + 15 * DAY);
  });

  it("kalan < 15 gün: çerez 30 güne uzatılır, oturum aynı kullanıcı", async () => {
    const res = await renew(req(cookieIssuedDaysAgo(20)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.renewed).toBe(true);
    const value = cookieValue(res);
    expect(value).not.toBeNull();
    expect(verifyClientSession(value)).toEqual({ clientUserId: user.id, clientId: user.clientId });
    // Yeni çerez 29 gün sonra hâlâ geçerli, 31 gün sonra değil.
    expect(verifyClientSession(value, new Date(Date.now() + 29 * DAY))).not.toBeNull();
    expect(verifyClientSession(value, new Date(Date.now() + 31 * DAY))).toBeNull();
    const setCookie = (res.headers.get("set-cookie") ?? "").toLowerCase();
    expect(setCookie).toContain("httponly");
    expect(setCookie).toContain("samesite=lax");
    const renewAt = Date.parse(body.renewAt);
    const expected =
      Date.now() + (CLIENT_SESSION_TTL_SECONDS - CLIENT_SESSION_RENEW_BELOW_SECONDS) * 1000;
    expect(Math.abs(renewAt - expected)).toBeLessThan(5_000);
  });

  it("süresi dolmuş çerez diriltilemez (401)", async () => {
    const res = await renew(req(cookieIssuedDaysAgo(31)));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("oturumsuz 401", async () => {
    expect((await renew(req())).status).toBe(401);
  });

  it("erişimi kaldırılmış kullanıcı (satır silindi) yenileyemez", async () => {
    const cookie = cookieIssuedDaysAgo(20);
    await db.clientUser.delete({ where: { id: user.id } });
    expect((await renew(req(cookie))).status).toBe(401);
  });

  it("yabancı Origin 403, çerez yazılmaz", async () => {
    const res = await renew(req(cookieIssuedDaysAgo(20), "https://kotu.example"));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
