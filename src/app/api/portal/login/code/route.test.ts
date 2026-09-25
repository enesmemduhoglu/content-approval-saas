import { beforeEach, describe, expect, it, vi } from "vitest";

// Giriş maili `after()` içinde gidiyor; test işi yakalayıp elle bekliyor
// (bkz. ../route.test.ts — aynı kalıp).
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
import {
  CLIENT_SESSION_COOKIE,
  LOGIN_CODE_DAILY_FAILURE_CAP,
  LOGIN_CODE_MAX_ATTEMPTS,
  consumeLoginCode,
  hashLoginCode,
  verifyClientSession,
} from "@/lib/client-auth";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import { createClientUser, portalRequest } from "@tests/helpers/portal";
import { POST as login } from "../route";
import { POST as verify } from "../verify/route";
import { POST as codeLogin } from "./route";

const mockSend = vi.mocked(sendPortalLoginEmail);

async function flush() {
  await Promise.all(deferred.splice(0));
}

/** Son giden mailin link token'ı ve kodu. */
function lastMail(): { token: string; code: string } {
  const input = mockSend.mock.calls.at(-1)?.[0];
  if (!input) throw new Error("mail gönderilmedi");
  return {
    token: new URL(input.loginUrl).searchParams.get("token") as string,
    code: input.code,
  };
}

async function issue(email = userEmail): Promise<{ token: string; code: string }> {
  await login(portalRequest("/api/portal/login", { method: "POST", body: { email } }));
  await flush();
  return lastMail();
}

/** Doğru koddan kesinlikle farklı 6 hane. */
function wrong(code: string, i = 0): string {
  return String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0");
}

const codeReq = (
  email: string,
  code: unknown,
  extra: { ip?: string; origin?: string } = {}
) => portalRequest("/api/portal/login/code", { method: "POST", body: { email, code }, ...extra });

const verifyReq = (token: string) =>
  portalRequest("/api/portal/login/verify", { method: "POST", body: { token } });

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

describe("POST /api/portal/login/code — doğru kod", () => {
  it("oturum çerezi kurar (link akışıyla aynı: httpOnly, lax) ve token'ı tüketir", async () => {
    const { code } = await issue();
    const res = await codeLogin(codeReq(userEmail, code));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${CLIENT_SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    const value = setCookie.split(";")[0].split("=").slice(1).join("=");
    const user = await db.clientUser.findUniqueOrThrow({ where: { email: userEmail } });
    expect(verifyClientSession(value)).toEqual({ clientUserId: user.id, clientId: user.clientId });
    expect(user.lastLoginAt).not.toBeNull();
    const row = await db.clientLoginToken.findFirstOrThrow();
    expect(row.usedAt).not.toBeNull();
  });

  it("aynı kod ikinci kez kullanılamaz", async () => {
    const { code } = await issue();
    expect((await codeLogin(codeReq(userEmail, code))).status).toBe(200);
    const again = await codeLogin(codeReq(userEmail, code));
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("büyük harfli adres ve boşluklu kod ('123 456') kabul edilir", async () => {
    const { code } = await issue();
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect((await codeLogin(codeReq("  FURKAN@Ornek.com ", spaced))).status).toBe(200);
  });

  it("yalnızca EN SON token'ın kodu geçer", async () => {
    const first = await issue();
    const second = await issue();
    // İki kod tesadüfen aynı olabilir (1/10⁶); o durumda test anlamsız.
    if (first.code === second.code) return;
    expect((await codeLogin(codeReq(userEmail, first.code))).status).toBe(401);
    expect((await codeLogin(codeReq(userEmail, second.code))).status).toBe(200);
  });
});

describe("POST /api/portal/login/code — link ve kod aynı token", () => {
  it("link kullanıldıysa kod ölü", async () => {
    const { token, code } = await issue();
    expect((await verify(verifyReq(token))).status).toBe(200);
    expect((await codeLogin(codeReq(userEmail, code))).status).toBe(401);
  });

  it("kod kullanıldıysa link ölü", async () => {
    const { token, code } = await issue();
    expect((await codeLogin(codeReq(userEmail, code))).status).toBe(200);
    expect((await verify(verifyReq(token))).status).toBe(410);
  });
});

describe("POST /api/portal/login/code — kaba kuvvet", () => {
  it(`${LOGIN_CODE_MAX_ATTEMPTS} yanlış denemede token kilitlenir: doğru kod ve link de geçmez`, async () => {
    const { token, code } = await issue();
    for (let i = 0; i < LOGIN_CODE_MAX_ATTEMPTS; i++) {
      // Her deneme farklı IP'den: IP sınırına değil token sayacına çarpsın.
      const res = await codeLogin(codeReq(userEmail, wrong(code, i), { ip: `9.9.9.${i}` }));
      expect(res.status).toBe(401);
    }
    const row = await db.clientLoginToken.findFirstOrThrow();
    expect(row.attempts).toBe(LOGIN_CODE_MAX_ATTEMPTS);
    resetRateLimiter();
    expect((await codeLogin(codeReq(userEmail, code))).status).toBe(401);
    expect((await verify(verifyReq(token))).status).toBe(410);
  });

  it("paralel yanlış denemeler sayacı tavanın üstüne çıkaramaz (koşullu artış)", async () => {
    const { code } = await issue();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => consumeLoginCode(userEmail, wrong(code, i)))
    );
    const row = await db.clientLoginToken.findFirstOrThrow();
    expect(row.attempts).toBe(LOGIN_CODE_MAX_ATTEMPTS);
    expect(row.usedAt).toBeNull();
  });

  it("günlük tavan: son 24 saatte toplam hatalı deneme dolunca yeni token'ın doğru kodu da geçmez; link geçer", async () => {
    const user = await db.clientUser.findUniqueOrThrow({ where: { email: userEmail } });
    // Önceki (kilitli) token'lar: toplam tavan kadar hatalı deneme.
    const perToken = LOGIN_CODE_MAX_ATTEMPTS;
    for (let i = 0; i < LOGIN_CODE_DAILY_FAILURE_CAP / perToken; i++) {
      await db.clientLoginToken.create({
        data: {
          clientUserId: user.id,
          tokenHash: `eski-${i}`,
          codeHash: "x",
          attempts: perToken,
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      });
    }
    const { token, code } = await issue();
    expect((await codeLogin(codeReq(userEmail, code))).status).toBe(401);
    expect((await verify(verifyReq(token))).status).toBe(200);
  });

  it("24 saatten eski hatalı denemeler günlük tavana sayılmaz", async () => {
    const user = await db.clientUser.findUniqueOrThrow({ where: { email: userEmail } });
    await db.clientLoginToken.create({
      data: {
        clientUserId: user.id,
        tokenHash: "dunku",
        attempts: LOGIN_CODE_DAILY_FAILURE_CAP,
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });
    const { code } = await issue();
    expect((await codeLogin(codeReq(userEmail, code))).status).toBe(200);
  });

  it("süresi dolmuş token'ın kodu geçmez", async () => {
    const { code } = await issue();
    await db.clientLoginToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await codeLogin(codeReq(userEmail, code))).status).toBe(401);
  });

  it("biçimi bozuk kod 400 ve deneme SAYILMAZ", async () => {
    const { code } = await issue();
    for (const bad of ["12a456", "12345", "1234567", "", 123456, null]) {
      const res = await codeLogin(codeReq(userEmail, bad));
      expect(res.status).toBe(400);
    }
    const row = await db.clientLoginToken.findFirstOrThrow();
    expect(row.attempts).toBe(0);
    resetRateLimiter();
    expect((await codeLogin(codeReq(userEmail, code))).status).toBe(200);
  });

  it("yabancı Origin 403, deneme sayılmaz", async () => {
    const { code } = await issue();
    const res = await codeLogin(codeReq(userEmail, wrong(code), { origin: "https://kotu.example" }));
    expect(res.status).toBe(403);
    expect((await db.clientLoginToken.findFirstOrThrow()).attempts).toBe(0);
  });
});

describe("POST /api/portal/login/code — sızdırmama ve saklama", () => {
  it("kayıtsız adres ile kayıtlı adresin yanlış kodu BİREBİR aynı yanıtı alır", async () => {
    const { code } = await issue();
    const known = await codeLogin(codeReq(userEmail, wrong(code), { ip: "4.4.4.1" }));
    const unknown = await codeLogin(codeReq("yok@ornek.com", wrong(code), { ip: "4.4.4.2" }));
    const noToken = await codeLogin(codeReq("yok2@ornek.com", code, { ip: "4.4.4.3" }));
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(known.status);
    expect(noToken.status).toBe(known.status);
    const body = await known.json();
    expect(await unknown.json()).toEqual(body);
    expect(await noToken.json()).toEqual(body);
  });

  it("DB'ye kodun kendisi değil HMAC'i yazılır", async () => {
    const { code } = await issue();
    const row = await db.clientLoginToken.findFirstOrThrow();
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toContain(code);
    expect(row.codeHash).toBe(hashLoginCode(row.tokenHash, code));
    // Anahtarsız düz SHA-256 değil: tablo tek başına kaba kuvvete açık olmasın.
    const { createHash } = await import("node:crypto");
    expect(row.codeHash).not.toBe(createHash("sha256").update(code).digest("hex"));
    expect(row.codeHash).not.toBe(
      createHash("sha256").update(`${row.tokenHash}.${code}`).digest("hex")
    );
  });

  it("kod 6 hane; e-postaya giden kod ile satırdaki hash eşleşir", async () => {
    const { code } = await issue();
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe("POST /api/portal/login/code — hız sınırı", () => {
  it("IP başına: aynı IP'den 11. istek 429 (farklı adreslerle de)", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await codeLogin(codeReq(`kisi${i}@ornek.com`, "000000", { ip: "5.5.5.5" }));
      expect(res.status).toBe(401);
    }
    expect((await codeLogin(codeReq("baska@ornek.com", "000000", { ip: "5.5.5.5" }))).status).toBe(
      429
    );
  });

  it("e-posta başına: farklı IP'lerden 6. istek 429", async () => {
    for (let i = 0; i < 5; i++) {
      await codeLogin(codeReq("hedef@ornek.com", "000000", { ip: `6.6.6.${i}` }));
    }
    expect(
      (await codeLogin(codeReq("hedef@ornek.com", "000000", { ip: "6.6.6.99" }))).status
    ).toBe(429);
  });
});
