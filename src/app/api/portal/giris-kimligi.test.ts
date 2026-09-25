import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Giriş maili `after()` içinde gidiyor; test işi yakalayıp elle bekliyor
// (bkz. login/route.test.ts — aynı kalıp).
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
  CLIENT_TRACE_COOKIE,
  CLIENT_TRACE_TTL_SECONDS,
  signClientSession,
  signPortalTrace,
  verifyClientSession,
  verifyPortalTrace,
} from "@/lib/client-auth";
import { createAgency, createClient, resetDb } from "@tests/helpers/db";
import {
  createClientUser,
  portalRequest,
  portalTraceCookie,
  setCookieLine,
  setCookieValue,
} from "@tests/helpers/portal";
import { POST as login } from "./login/route";
import { POST as verifyLink } from "./login/verify/route";
import { POST as codeLogin } from "./login/code/route";
import { POST as logout } from "./logout/route";
import { POST as renewSession } from "./session/route";
import { GET as listVideos } from "./videos/route";
import { GET as getSettings } from "./settings/route";

/**
 * K29 — giriş ekranı kimliği: imzalı iz çerezi. Burada yazılma (link, kod,
 * yenileme), silinmeme (çıkış), sahtecilik ve "iz bir yetki değil" sınanıyor;
 * izin okunduğu yerler (manifest, layout, giriş sayfası) kendi testlerinde.
 */
const DAY = 24 * 60 * 60 * 1000;
const mockSend = vi.mocked(sendPortalLoginEmail);

async function flush() {
  await Promise.all(deferred.splice(0));
}

async function issueMail(email: string): Promise<{ token: string; code: string }> {
  await login(portalRequest("/api/portal/login", { method: "POST", body: { email } }));
  await flush();
  const input = mockSend.mock.calls.at(-1)?.[0];
  if (!input) throw new Error("mail gönderilmedi");
  return { token: new URL(input.loginUrl).searchParams.get("token") as string, code: input.code };
}

const linkLogin = (token: string) =>
  verifyLink(portalRequest("/api/portal/login/verify", { method: "POST", body: { token } }));

let clientA: { id: string };
let clientB: { id: string };
let userA: { id: string; clientId: string; email: string };
let userB: { id: string; clientId: string; email: string };

beforeEach(async () => {
  await resetDb();
  resetRateLimiter();
  mockSend.mockClear();
  deferred.length = 0;
  const agency = await createAgency();
  clientA = await createClient(agency.id);
  clientB = await createClient(agency.id);
  userA = await createClientUser(clientA.id, "furkan@ornek.com");
  userB = await createClientUser(clientB.id, "baska@ornek.com");
});

describe("iz çerezi — başarılı girişte yazılır", () => {
  it("link girişi: izde müşterinin clientId'si; httpOnly, lax, path=/portal, ~1 yıl", async () => {
    const { token } = await issueMail(userA.email);
    const res = await linkLogin(token);
    expect(res.status).toBe(200);

    const value = setCookieValue(res, CLIENT_TRACE_COOKIE);
    expect(verifyPortalTrace(value)).toBe(clientA.id);

    const line = (setCookieLine(res, CLIENT_TRACE_COOKIE) ?? "").toLowerCase();
    expect(line).toContain("httponly");
    expect(line).toContain("samesite=lax");
    expect(line).toContain("path=/portal;");
    const expires = Date.parse(/expires=([^;]+)/.exec(line)?.[1] ?? "");
    expect(Math.abs(expires - (Date.now() + CLIENT_TRACE_TTL_SECONDS * 1000))).toBeLessThan(
      5_000
    );
    // Oturum çerezi de her zamanki gibi yazıldı; iz onun yerine geçmiyor.
    expect(verifyClientSession(setCookieValue(res, CLIENT_SESSION_COOKIE))).toEqual({
      clientUserId: userA.id,
      clientId: clientA.id,
    });
  });

  it("kodla giriş: aynı iz (link akışıyla ortak oturum kurma yolu)", async () => {
    const { code } = await issueMail(userA.email);
    const res = await codeLogin(
      portalRequest("/api/portal/login/code", {
        method: "POST",
        body: { email: userA.email, code },
      })
    );
    expect(res.status).toBe(200);
    expect(verifyPortalTrace(setCookieValue(res, CLIENT_TRACE_COOKIE))).toBe(clientA.id);
  });

  it("iz yalnızca clientId (+ bitiş) taşır — e-posta, kullanıcı id'si yok", async () => {
    const { token } = await issueMail(userA.email);
    const value = setCookieValue(await linkLogin(token), CLIENT_TRACE_COOKIE) ?? "";
    const payload = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString("utf8"));
    expect(Object.keys(payload).sort()).toEqual(["c", "exp"]);
    expect(value).not.toContain(userA.id);
    expect(JSON.stringify(payload)).not.toContain("ornek.com");
  });

  it("başarısız girişte iz yazılmaz", async () => {
    const { code } = await issueMail(userA.email);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const res = await codeLogin(
      portalRequest("/api/portal/login/code", {
        method: "POST",
        body: { email: userA.email, code: wrong },
      })
    );
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await linkLogin("a".repeat(32))).headers.getSetCookie()).toEqual([]);
  });

  it("oturum yenilemesi izi de tazeler", async () => {
    const old = signClientSession(
      { clientUserId: userA.id, clientId: clientA.id },
      new Date(Date.now() - 20 * DAY)
    ).value;
    const res = await renewSession(
      portalRequest("/api/portal/session", {
        method: "POST",
        cookie: `${CLIENT_SESSION_COOKIE}=${old}`,
      })
    );
    expect((await res.json()).renewed).toBe(true);
    expect(verifyPortalTrace(setCookieValue(res, CLIENT_TRACE_COOKIE))).toBe(clientA.id);
  });

  it("aynı cihazda başka müşteriye giriş: iz son girişin müşterisine geçer", async () => {
    const first = await linkLogin((await issueMail(userA.email)).token);
    expect(verifyPortalTrace(setCookieValue(first, CLIENT_TRACE_COOKIE))).toBe(clientA.id);
    const second = await linkLogin((await issueMail(userB.email)).token);
    // Aynı ad + aynı path: tarayıcı eskisinin üzerine yazar.
    expect(setCookieLine(second, CLIENT_TRACE_COOKIE)).toContain("Path=/portal");
    expect(verifyPortalTrace(setCookieValue(second, CLIENT_TRACE_COOKIE))).toBe(clientB.id);
  });
});

describe("iz çerezi — çıkışta silinmez", () => {
  it("çıkış yalnızca oturum çerezini siler", async () => {
    const res = await logout(
      portalRequest("/api/portal/logout", {
        method: "POST",
        cookie: `${portalTraceCookie(clientA.id)}`,
      })
    );
    expect(res.status).toBe(200);
    expect(setCookieValue(res, CLIENT_SESSION_COOKIE)).toBe("");
    expect(setCookieLine(res, CLIENT_TRACE_COOKIE)).toBeNull();
  });
});

describe("iz çerezi — sahtecilik", () => {
  it("geçerli iz clientId'yi verir", () => {
    expect(verifyPortalTrace(signPortalTrace(clientA.id).value)).toBe(clientA.id);
  });

  it("imzasız ya da düz clientId → null", () => {
    expect(verifyPortalTrace(clientA.id)).toBeNull();
    const payload = Buffer.from(JSON.stringify({ c: clientA.id, exp: 9e9 })).toString("base64url");
    expect(verifyPortalTrace(`k1.${payload}`)).toBeNull();
    expect(verifyPortalTrace(`k1.${payload}.`)).toBeNull();
  });

  it("yükü değiştirilmiş iz (başka müşterinin id'si, eski imza) → null", () => {
    const [prefix, , sig] = signPortalTrace(clientA.id).value.split(".");
    const forged = Buffer.from(
      JSON.stringify({ c: clientB.id, exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString("base64url");
    expect(verifyPortalTrace(`${prefix}.${forged}.${sig}`)).toBeNull();
  });

  it("başka bir sırla imzalanmış iz → null", () => {
    const original = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "baska-bir-sir";
    const foreign = signPortalTrace(clientA.id).value;
    process.env.AUTH_SECRET = original;
    expect(verifyPortalTrace(foreign)).toBeNull();
  });

  it("aynı sırrın OTURUM anahtarıyla imzalanmış iz → null (etiketli türetme)", () => {
    const sessionKey = createHmac("sha256", process.env.AUTH_SECRET as string)
      .update("cas-portal-session-v1")
      .digest();
    const payload = Buffer.from(
      JSON.stringify({ c: clientA.id, exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString("base64url");
    const sig = createHmac("sha256", sessionKey).update(`k1.${payload}`).digest("base64url");
    expect(verifyPortalTrace(`k1.${payload}.${sig}`)).toBeNull();
  });

  it("süresi dolmuş iz → null", () => {
    const value = signPortalTrace(clientA.id, new Date(Date.now() - 366 * DAY)).value;
    expect(verifyPortalTrace(value)).toBeNull();
    const fresh = signPortalTrace(clientA.id).value;
    expect(verifyPortalTrace(fresh, new Date(Date.now() + 364 * DAY))).toBe(clientA.id);
  });

  it("oturum çerezi iz olarak, iz oturum olarak geçmez", () => {
    const session = signClientSession({ clientUserId: userA.id, clientId: clientA.id }).value;
    expect(verifyPortalTrace(session)).toBeNull();
    expect(verifyClientSession(signPortalTrace(clientA.id).value)).toBeNull();
  });
});

describe("iz çerezi — hiçbir yetki vermez", () => {
  // Tarayıcı izi `/api` altına göndermiyor (path=/portal); yine de biri elle
  // eklerse ya da kapsam bir gün değişirse API'ler onu tanımamalı.
  const trace = () => portalTraceCookie(clientA.id);

  it("izli ama oturumsuz liste isteği 401", async () => {
    const res = await listVideos(portalRequest("/api/portal/videos", { cookie: trace() }));
    expect(res.status).toBe(401);
  });

  it("izli ama oturumsuz ayarlar isteği 401", async () => {
    const res = await getSettings(portalRequest("/api/portal/settings", { cookie: trace() }));
    expect(res.status).toBe(401);
  });

  it("izli ama oturumsuz yenileme 401 — iz oturum doğuramaz", async () => {
    const res = await renewSession(
      portalRequest("/api/portal/session", { method: "POST", cookie: trace() })
    );
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("izin değeri oturum çerezinin adına konsa bile 401", async () => {
    const value = signPortalTrace(clientA.id).value;
    const res = await listVideos(
      portalRequest("/api/portal/videos", { cookie: `${CLIENT_SESSION_COOKIE}=${value}` })
    );
    expect(res.status).toBe(401);
  });

  it("silinmiş kullanıcının izi kalır ama erişim vermez", async () => {
    await db.clientUser.delete({ where: { id: userA.id } });
    const res = await listVideos(portalRequest("/api/portal/videos", { cookie: trace() }));
    expect(res.status).toBe(401);
  });
});
