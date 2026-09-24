import { beforeEach, describe, expect, it, vi } from "vitest";

// `after()` istek kapsamı dışında (doğrudan çağrılan handler) patlar; test onu
// yakalayıp işi elle bekliyor ki "yanıt gitti, sonra mail" sırası da sınansın.
const deferred: Promise<unknown>[] = [];
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => Promise<unknown>) => {
      deferred.push(Promise.resolve().then(task));
    },
  };
});

vi.mock("@/lib/email-portal", () => ({
  sendPortalLoginEmail: vi.fn(async () => ({ sent: true })),
}));

import { db } from "@/lib/db";
import { resetRateLimiter } from "@/lib/rate-limit";
import { sendPortalLoginEmail } from "@/lib/email-portal";
import { CLIENT_SESSION_COOKIE, hashLoginToken, verifyClientSession } from "@/lib/client-auth";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, portalRequest } from "@tests/helpers/portal";
import { POST as login } from "./route";
import { POST as verify } from "./verify/route";
import { POST as logout } from "../logout/route";

const mockSend = vi.mocked(sendPortalLoginEmail);

async function flush() {
  await Promise.all(deferred.splice(0));
}

function sentToken(): string {
  const url = mockSend.mock.calls.at(-1)?.[0].loginUrl;
  if (!url) throw new Error("mail gönderilmedi");
  return new URL(url).searchParams.get("token") as string;
}

const loginReq = (email: string, extra: { ip?: string; origin?: string } = {}) =>
  portalRequest("/api/portal/login", { method: "POST", body: { email }, ...extra });

const verifyReq = (token: string, extra: { origin?: string } = {}) =>
  portalRequest("/api/portal/login/verify", { method: "POST", body: { token }, ...extra });

let userEmail: string;

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  mockSend.mockClear();
  deferred.length = 0;
  const agency = await createAgency();
  const client = await createClient(agency.id);
  userEmail = (await createClientUser(client.id, "furkan@ornek.com")).email;
});

describe("POST /api/portal/login — e-posta sızdırmama", () => {
  it("kayıtlı ve kayıtsız adres BİREBİR aynı yanıtı alır", async () => {
    const known = await login(loginReq(userEmail, { ip: "1.1.1.1" }));
    const unknown = await login(loginReq("yok@ornek.com", { ip: "1.1.1.2" }));
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
    await flush();
    // Mail yalnızca kayıtlı adrese gitti — ama bunu yanıt söylemedi.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].to).toBe(userEmail);
  });

  it("mail YANITTAN SONRA gönderilir (zamanlama kayıtlılığı söylemesin)", async () => {
    await login(loginReq(userEmail));
    expect(mockSend).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("büyük/küçük harf ve boşluk fark etmez", async () => {
    await login(loginReq("  FURKAN@Ornek.com "));
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("DB'ye token değil yalnızca SHA-256 hash'i yazılır; ömür 15 dk", async () => {
    await login(loginReq(userEmail));
    await flush();
    const token = sentToken();
    const rows = await db.clientLoginToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashLoginToken(token));
    expect(rows[0].tokenHash).not.toContain(token);
    const ttlMs = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(14 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60_000 + 1000);
  });

  it("geçersiz e-posta 400", async () => {
    const res = await login(loginReq("adres-degil"));
    expect(res.status).toBe(400);
  });

  it("yabancı Origin 403", async () => {
    const res = await login(loginReq(userEmail, { origin: "https://kotu.example" }));
    expect(res.status).toBe(403);
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("e-posta başına hız sınırı: 4. istek 429 (farklı IP'lerden de)", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await login(loginReq(userEmail, { ip: `2.2.2.${i}` }))).status).toBe(200);
    }
    expect((await login(loginReq(userEmail, { ip: "2.2.2.99" }))).status).toBe(429);
  });

  it("IP başına hız sınırı: aynı IP'den 11. istek 429 (farklı adreslerle de)", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await login(loginReq(`kisi${i}@ornek.com`, { ip: "3.3.3.3" }))).status).toBe(200);
    }
    expect((await login(loginReq("baska@ornek.com", { ip: "3.3.3.3" }))).status).toBe(429);
  });
});

describe("POST /api/portal/login/verify — tek kullanım ve süre", () => {
  async function issue(): Promise<string> {
    await login(loginReq(userEmail));
    await flush();
    return sentToken();
  }

  it("geçerli token oturum çerezi kurar: httpOnly, lax, 30 gün", async () => {
    const token = await issue();
    const res = await verify(verifyReq(token));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${CLIENT_SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    const value = setCookie.split(";")[0].split("=").slice(1).join("=");
    const session = verifyClientSession(value);
    expect(session).not.toBeNull();
    const user = await db.clientUser.findUniqueOrThrow({ where: { email: userEmail } });
    expect(session).toEqual({ clientUserId: user.id, clientId: user.clientId });
    expect(user.lastLoginAt).not.toBeNull();
  });

  it("aynı token ikinci kez kullanılamaz (410)", async () => {
    const token = await issue();
    expect((await verify(verifyReq(token))).status).toBe(200);
    const again = await verify(verifyReq(token));
    expect(again.status).toBe(410);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("eşzamanlı iki kullanımda yalnızca biri oturum alır", async () => {
    const token = await issue();
    const results = await Promise.all([verify(verifyReq(token)), verify(verifyReq(token))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
  });

  it("süresi dolmuş token 410", async () => {
    const token = await issue();
    await db.clientLoginToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify(verifyReq(token))).status).toBe(410);
  });

  it("uydurma token 410 — kullanılmış/dolmuş ile aynı yanıt", async () => {
    const res = await verify(verifyReq("a".repeat(32)));
    expect(res.status).toBe(410);
  });

  it("yabancı Origin 403, token harcanmaz", async () => {
    const token = await issue();
    expect((await verify(verifyReq(token, { origin: "https://kotu.example" }))).status).toBe(403);
    expect((await verify(verifyReq(token))).status).toBe(200);
  });
});

describe("POST /api/portal/logout", () => {
  it("çerezi siler", async () => {
    const res = await logout(portalRequest("/api/portal/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${CLIENT_SESSION_COOKIE}=;`);
  });

  it("yabancı Origin 403", async () => {
    const res = await logout(
      portalRequest("/api/portal/logout", { method: "POST", origin: "https://kotu.example" })
    );
    expect(res.status).toBe(403);
  });
});
