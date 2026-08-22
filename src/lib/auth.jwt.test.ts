import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JWT } from "next-auth/jwt";

/**
 * F6 — jwt/session callback'lerinin davranışı.
 *
 * Bu dosyanın koruduğu iki şey:
 *  1. Üyelik çözümünün auth katmanında bitmesi — token'a düz bir `agencyId`
 *     konuyor, aşağı akıştaki 78 çağrı yeri ve `getScopedDb` sözleşmesi
 *     dokunulmadan kalıyor.
 *  2. JWT BAYATLIĞI: ekipten çıkarılan birinin elindeki token, üyelik
 *     doğrulaması yenilendiğinde erişimini KAYBETMELİ. Aksi halde "çıkar"
 *     tıklaması token'ın ömrü (30 gün) boyunca hiçbir şey yapmamış olurdu.
 */

type Callbacks = {
  jwt: (args: {
    token: JWT;
    user?: { email?: string | null; name?: string | null };
    account?: { provider?: string; providerAccountId?: string } | null;
  }) => Promise<JWT>;
  session: (args: { session: Record<string, unknown>; token: JWT }) => Promise<
    Record<string, unknown>
  >;
};

const configs: { callbacks?: Callbacks }[] = [];

vi.mock("next-auth", () => ({
  default: (config: { callbacks?: Callbacks }) => {
    configs.push(config);
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

const resolveMembershipOnSignIn = vi.fn();
const findMembership = vi.fn();
vi.mock("@/lib/membership", () => ({
  resolveMembershipOnSignIn: (...args: unknown[]) => resolveMembershipOnSignIn(...args),
  findMembership: (...args: unknown[]) => findMembership(...args),
}));

async function loadCallbacks(): Promise<{
  callbacks: Callbacks;
  revalidateMs: number;
}> {
  configs.length = 0;
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  const mod = await import("./auth");
  return {
    callbacks: configs.at(-1)!.callbacks!,
    revalidateMs: mod.MEMBERSHIP_REVALIDATE_MS,
  };
}

const UYELIK = {
  memberId: "m1",
  agencyId: "ag1",
  agencyName: "Ajans",
  role: "owner" as const,
};

beforeEach(() => {
  resolveMembershipOnSignIn.mockReset();
  findMembership.mockReset();
  resolveMembershipOnSignIn.mockResolvedValue(UYELIK);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("jwt callback — giriş", () => {
  it("Google girişinde providerAccountId'yi kimlik olarak kullanır", async () => {
    const { callbacks } = await loadCallbacks();
    const token = await callbacks.jwt({
      token: {},
      user: { email: "a@ornek.com", name: "A" },
      account: { provider: "google", providerAccountId: "gid-123" },
    });

    expect(resolveMembershipOnSignIn).toHaveBeenCalledWith({
      googleId: "gid-123",
      email: "a@ornek.com",
      name: "A",
    });
    expect(token.agencyId).toBe("ag1");
    expect(token.googleId).toBe("gid-123");
    expect(token.agencyRole).toBe("owner");
  });

  // Test girişinin `test:` öneki, gerçek bir Google providerAccountId ile
  // çakışmasını engelliyor. F6 bu kimliği Agency'den AgencyMember'a taşıdı;
  // önek aynı işi görmeye devam etmeli.
  it("test girişinde googleId `test:` önekli kalır", async () => {
    const { callbacks } = await loadCallbacks();
    const token = await callbacks.jwt({
      token: {},
      user: { email: "t@ornek.com" },
      account: { provider: "credentials" },
    });
    expect(token.googleId).toBe("test:t@ornek.com");
  });
});

describe("jwt callback — üyelik tazeleme (JWT bayatlığı)", () => {
  it("tazeleme aralığı DOLMADAN DB'ye gitmez", async () => {
    const { callbacks } = await loadCallbacks();
    const token = await callbacks.jwt({
      token: { googleId: "gid", agencyId: "ag1", membershipCheckedAt: Date.now() },
    });
    expect(findMembership).not.toHaveBeenCalled();
    expect(token.agencyId).toBe("ag1");
  });

  it("aralık dolduğunda üyeliği yeniden doğrular", async () => {
    const { callbacks, revalidateMs } = await loadCallbacks();
    findMembership.mockResolvedValue({ ...UYELIK, agencyName: "Yeni Ad" });

    const token = await callbacks.jwt({
      token: {
        googleId: "gid",
        agencyId: "ag1",
        membershipCheckedAt: Date.now() - revalidateMs - 1,
      },
    });
    expect(findMembership).toHaveBeenCalledWith("gid");
    expect(token.agencyName).toBe("Yeni Ad");
  });

  // ─── ASIL REGRESYON ────────────────────────────────────────────────────
  it("üyelik gitmişse agencyId token'dan SİLİNİR (erişim kesilir)", async () => {
    const { callbacks, revalidateMs } = await loadCallbacks();
    findMembership.mockResolvedValue(null);

    const token = await callbacks.jwt({
      token: {
        googleId: "gid",
        agencyId: "ag1",
        agencyName: "Ajans",
        agencyRole: "member",
        membershipCheckedAt: Date.now() - revalidateMs - 1,
      },
    });

    expect(token.agencyId).toBeUndefined();
    expect(token.agencyRole).toBeUndefined();
    // Ve session'a da düşmez: route'ların `if (!session?.agencyId)` kapısı devreye girer.
    const session = await callbacks.session({ session: {}, token });
    expect(session.agencyId).toBeUndefined();
  });

  it("çıkarılan üyeye tazeleme sırasında YENİ AJANS AÇILMAZ", async () => {
    const { callbacks, revalidateMs } = await loadCallbacks();
    findMembership.mockResolvedValue(null);

    await callbacks.jwt({
      token: {
        googleId: "gid",
        agencyId: "ag1",
        membershipCheckedAt: Date.now() - revalidateMs - 1,
      },
    });
    expect(resolveMembershipOnSignIn).not.toHaveBeenCalled();
  });

  // Geriye dönük uyum: deploy anında dolaşımda olan F6 öncesi token'lar
  // `googleId` taşımıyor. Doğrulanamazlar ama iptal de EDİLMEZLER — aksi
  // halde deploy, o an giriş yapmış herkesi kapı dışarı ederdi.
  it("F6 öncesi token (googleId'siz) olduğu gibi bırakılır", async () => {
    const { callbacks } = await loadCallbacks();
    const token = await callbacks.jwt({ token: { agencyId: "eski-ajans" } });
    expect(token.agencyId).toBe("eski-ajans");
    expect(findMembership).not.toHaveBeenCalled();
  });
});

describe("session callback", () => {
  it("agencyId/agencyName/agencyRole'ü session'a taşır", async () => {
    const { callbacks } = await loadCallbacks();
    const session = await callbacks.session({
      session: {},
      token: { agencyId: "ag1", agencyName: "Ajans", agencyRole: "owner" },
    });
    expect(session).toMatchObject({
      agencyId: "ag1",
      agencyName: "Ajans",
      agencyRole: "owner",
    });
  });

  it("bilinmeyen bir rol session'a geçmez (allowlist)", async () => {
    const { callbacks } = await loadCallbacks();
    const session = await callbacks.session({
      session: {},
      token: { agencyId: "ag1", agencyRole: "admin" as never },
    });
    expect(session.agencyRole).toBeUndefined();
  });
});
