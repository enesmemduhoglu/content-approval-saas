import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateApiKey, MIN_API_KEY_LENGTH } from "./api-key";

const VALID_KEY = "k".repeat(MIN_API_KEY_LENGTH);
const AGENCY_ID = "agency-123";

function request(authorization?: string) {
  return new Request("http://localhost/api/posts", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  process.env.FURI_API_KEY = VALID_KEY;
  process.env.FURI_API_AGENCY_ID = AGENCY_ID;
});

afterEach(() => {
  delete process.env.FURI_API_KEY;
  delete process.env.FURI_API_AGENCY_ID;
});

describe("authenticateApiKey", () => {
  it("doğru anahtar için agencyId döner", async () => {
    expect(await authenticateApiKey(request(`Bearer ${VALID_KEY}`))).toEqual({
      agencyId: AGENCY_ID,
    });
  });

  it("şema büyük/küçük harfe duyarsız", async () => {
    expect(await authenticateApiKey(request(`bearer ${VALID_KEY}`))).toEqual({
      agencyId: AGENCY_ID,
    });
  });

  it("yanlış anahtar null döner", async () => {
    expect(await authenticateApiKey(request(`Bearer ${"x".repeat(64)}`))).toBeNull();
  });

  it("doğru anahtarın öneki (kısa) kabul edilmez", async () => {
    expect(await authenticateApiKey(request(`Bearer ${VALID_KEY.slice(0, -1)}`))).toBeNull();
  });

  it("Authorization başlığı yoksa null döner", async () => {
    expect(await authenticateApiKey(request())).toBeNull();
  });

  it("Bearer olmayan şema kabul edilmez", async () => {
    expect(await authenticateApiKey(request(`Basic ${VALID_KEY}`))).toBeNull();
  });

  it("env yapılandırılmamışsa doğru görünen anahtar bile kabul edilmez", async () => {
    delete process.env.FURI_API_KEY;
    expect(await authenticateApiKey(request(`Bearer ${VALID_KEY}`))).toBeNull();
  });

  it("agency id eksikse anahtar devre dışı", async () => {
    delete process.env.FURI_API_AGENCY_ID;
    expect(await authenticateApiKey(request(`Bearer ${VALID_KEY}`))).toBeNull();
  });

  it(`${MIN_API_KEY_LENGTH} karakterden kısa anahtar devre dışı bırakılır`, async () => {
    const short = "abc";
    process.env.FURI_API_KEY = short;
    expect(await authenticateApiKey(request(`Bearer ${short}`))).toBeNull();
  });

  it("farklı uzunluktaki anahtar timingSafeEqual'ı patlatmaz", async () => {
    // Hash'lenerek karşılaştırıldığı için uzunluk farkı exception değil, null.
    await expect(authenticateApiKey(request("Bearer x"))).resolves.toBeNull();
    await expect(
      authenticateApiKey(request(`Bearer ${"y".repeat(500)}`))
    ).resolves.toBeNull();
  });
});
