import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Test girişi (Credentials provider) production'da VAR OLMAMALI.
 *
 * Bu dosyanın tek derdi o kapı. Önceden koşul yalnızca ortam değişkenine
 * bakıyordu: `ENABLE_TEST_AUTH=1` Vercel'e yanlışlıkla girildiğinde
 * /api/auth/signin üzerinden herkes istediği e-postayla giriş yapıp ajans
 * yaratabiliyordu. Artık `NODE_ENV === "production"` mutlak kapı; aşağıdaki
 * ilk test tam olarak o regresyonu bekliyor.
 */

// NextAuth'a geçirilen yapılandırmayı yakala — provider listesini başka türlü
// göremiyoruz (auth.ts yalnızca handlers/auth/signIn/signOut export ediyor).
type CapturedProvider = { id?: string; type?: string };
type CapturedConfig = { providers?: CapturedProvider[] };

const configs: CapturedConfig[] = [];

vi.mock("next-auth", () => ({
  default: (config: CapturedConfig) => {
    configs.push(config);
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

/** auth.ts'i verilen ortamla baştan yükler ve NextAuth'a giden config'i döner. */
async function loadAuth(env: Record<string, string>) {
  configs.length = 0;
  vi.resetModules();
  // Testler arası sızıntı olmasın: her yükleme kendi ortamını tam olarak kurar.
  vi.stubEnv("NODE_ENV", env.NODE_ENV);
  vi.stubEnv("ENABLE_TEST_AUTH", env.ENABLE_TEST_AUTH ?? "");
  vi.stubEnv("GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID ?? "");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", env.GOOGLE_CLIENT_SECRET ?? "");
  await import("./auth");
  return configs.at(-1)!;
}

/**
 * `type` üzerinden bakılıyor, `id` üzerinden DEĞİL: `Credentials()` fabrikası
 * kendisine verilen `id`'yi ("test-login") yok sayıp varsayılan
 * `id: "credentials"` ile dönüyor. Zaten sorulması gereken soru da bu —
 * production'da parola/credentials ile giriş yapılabilen HERHANGİ bir
 * provider bulunmamalı, adı ne olursa olsun.
 */
const hasCredentialsProvider = (config: CapturedConfig) =>
  (config.providers ?? []).some((provider) => provider.type === "credentials");

const providerIds = (config: CapturedConfig) =>
  (config.providers ?? []).map((provider) => provider.id);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("test girişi provider'ı", () => {
  it("production'da ENABLE_TEST_AUTH=1 OLSA BİLE eklenmez", async () => {
    const config = await loadAuth({ NODE_ENV: "production", ENABLE_TEST_AUTH: "1" });
    expect(hasCredentialsProvider(config)).toBe(false);
  });

  it("production'da yanlış yapılandırmayı yüksek sesle loglar", async () => {
    await loadAuth({ NODE_ENV: "production", ENABLE_TEST_AUTH: "1" });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("ENABLE_TEST_AUTH production'da set edilmiş")
    );
  });

  it("production'da değişken yokken hiç uyarı basmaz", async () => {
    const config = await loadAuth({ NODE_ENV: "production" });
    expect(hasCredentialsProvider(config)).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("geliştirmede ENABLE_TEST_AUTH=1 ile eklenir (e2e bu yolu kullanır)", async () => {
    const config = await loadAuth({ NODE_ENV: "development", ENABLE_TEST_AUTH: "1" });
    expect(hasCredentialsProvider(config)).toBe(true);
  });

  it("test ortamında değişkensiz de eklenir", async () => {
    const config = await loadAuth({ NODE_ENV: "test" });
    expect(hasCredentialsProvider(config)).toBe(true);
  });

  it("geliştirmede değişken yoksa eklenmez", async () => {
    const config = await loadAuth({ NODE_ENV: "development" });
    expect(hasCredentialsProvider(config)).toBe(false);
  });
});

describe("Google provider'ı", () => {
  it("kimlik bilgileri varsa production'da da durur", async () => {
    const config = await loadAuth({
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    expect(providerIds(config)).toContain("google");
    expect(hasCredentialsProvider(config)).toBe(false);
  });

  it("kimlik bilgileri yoksa eklenmez", async () => {
    const config = await loadAuth({ NODE_ENV: "production" });
    expect(providerIds(config)).not.toContain("google");
  });
});
