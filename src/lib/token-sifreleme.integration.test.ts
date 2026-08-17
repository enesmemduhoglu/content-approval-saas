import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1'in uçtan uca kanıtı: token DB'ye ŞİFRELİ giriyor ve onu kullanan her yol
 * çözülmüş hâlini alıyor mu?
 *
 * Neden ayrı bir dosya: mevcut entegrasyon testleri müşteriyi test yardımcısıyla
 * (doğrudan DB yazması, düz metin) oluşturuyor. O yol düz metin geçiş yolundan
 * geçtiği için ÇALIŞIR — ama şifrelemenin gerçekten devrede olduğunu kanıtlamaz.
 * Burada müşteri API üzerinden bağlanıyor, yani gerçek yazma yolundan.
 */

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/instagram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instagram")>()),
  fetchInstagramAccount: vi.fn(),
  refreshInstagramToken: vi.fn(),
  publishToInstagram: vi.fn(),
  checkMediaLiveness: vi.fn(),
}));

import { POST as connectInstagram } from "@/app/api/clients/[id]/instagram/route";
import { GET as getToken } from "@/app/api/clients/[id]/instagram-token/route";
import { GET as runCron } from "@/app/api/cron/refresh-instagram-tokens/route";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isEncrypted } from "@/lib/crypto";
import {
  fetchInstagramAccount,
  publishToInstagram,
  refreshInstagramToken,
} from "@/lib/instagram";
import { publishApprovedPost } from "@/lib/publish-post";
import {
  createAgency,
  createClient,
  createPendingPostWithLink,
  resetDb,
} from "@tests/helpers/db";

const mockAuth = vi.mocked(auth);
const mockFetchAccount = vi.mocked(fetchInstagramAccount);
const mockRefresh = vi.mocked(refreshInstagramToken);
const mockPublish = vi.mocked(publishToInstagram);

const GERCEK_TOKEN = "IGAAgercektokenbenzeriuzunbirdizi1234567890";
const IG_USER_ID = "17841400000000000";
const API_KEY = "k".repeat(40);
const CRON_SECRET = "c".repeat(40);

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Instagram'ı GERÇEK yazma yolundan bağlar (panel akışı). */
async function connectViaApi(clientId: string) {
  mockFetchAccount.mockResolvedValue({ userId: IG_USER_ID, username: "test_hesap" });
  const res = await connectInstagram(
    new Request("http://localhost/api/clients/x/instagram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: GERCEK_TOKEN,
        tokenExpiry: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
      }),
    }),
    params(clientId)
  );
  expect(res.status).toBe(200);
  return res;
}

const rawToken = async (clientId: string) =>
  (
    await db.client.findUniqueOrThrow({
      where: { id: clientId },
      select: { instagramAccessToken: true },
    })
  ).instagramAccessToken;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.stubEnv("FURI_API_KEY", API_KEY);
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
});

describe("token DB'ye şifreli yazılır", () => {
  it("panelden bağlanan token veritabanında DÜZ METİN durmaz", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);

    await connectViaApi(client.id);

    const stored = await rawToken(client.id);
    expect(stored).not.toBe(GERCEK_TOKEN);
    expect(stored).not.toContain(GERCEK_TOKEN);
    expect(isEncrypted(stored!)).toBe(true);
  });

  it("bağlantı kaldırılınca alan gerçekten NULL olur (şifreli boş değil)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    await connectViaApi(client.id);

    const { DELETE } = await import("@/app/api/clients/[id]/instagram/route");
    await DELETE(new Request("http://localhost", { method: "DELETE" }), params(client.id));

    expect(await rawToken(client.id)).toBeNull();
  });
});

describe("token'ı kullanan yollar çözülmüş hâlini alır", () => {
  it("furi'nin çektiği uç nokta GERÇEK token'ı döner (şifreli metni değil)", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    await connectViaApi(client.id);

    // Bu uç nokta yalnızca API anahtarı kabul eder, oturum değil.
    vi.stubEnv("FURI_API_AGENCY_ID", agency.id);
    mockAuth.mockResolvedValue(null as never);

    const res = await getToken(
      new Request("http://localhost/api/clients/x/instagram-token", {
        headers: { authorization: `Bearer ${API_KEY}` },
      }),
      params(client.id)
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accessToken).toBe(GERCEK_TOKEN);
    expect(isEncrypted(data.accessToken)).toBe(false);
  });

  it("yayın Instagram'a GERÇEK token'ı gönderir", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    await connectViaApi(client.id);

    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
    });
    mockPublish.mockResolvedValue({ mediaId: "m1", permalink: "https://ig/p/1" });

    const outcome = await publishApprovedPost(post.id);
    expect(outcome.publishStatus).toBe("published");
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: GERCEK_TOKEN })
    );
  });

  it("cron çözer, yeniler ve YENİ token'ı tekrar şifreleyerek yazar", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id);
    mockAuth.mockResolvedValue({ agencyId: agency.id } as never);
    await connectViaApi(client.id);

    // Yenileme penceresine sok (≤ 20 gün kaldı).
    await db.client.update({
      where: { id: client.id },
      data: { instagramTokenExpiry: new Date(Date.now() + 5 * 24 * 3600 * 1000) },
    });

    const YENI_TOKEN = "IGAAyenilenmistokenbenzeridizi0987654321";
    mockRefresh.mockResolvedValue({
      accessToken: YENI_TOKEN,
      expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000),
    });

    const res = await runCron(
      new Request("http://localhost/api/cron/refresh-instagram-tokens", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      })
    );
    expect((await res.json()).refreshed).toBe(1);

    // Instagram'a ÇÖZÜLMÜŞ eski token gitmiş olmalı...
    expect(mockRefresh).toHaveBeenCalledWith(GERCEK_TOKEN);
    // ...ve yeni token ŞİFRELİ yazılmış olmalı.
    const stored = await rawToken(client.id);
    expect(isEncrypted(stored!)).toBe(true);
    expect(stored).not.toContain(YENI_TOKEN);
  });
});

describe("geçiş yolu: düz metin kalıntı kayıtlar", () => {
  it("şifrelemeden önce yazılmış düz metin token çalışmaya devam eder", async () => {
    const agency = await createAgency();
    // Yardımcı doğrudan DB'ye yazıyor — şifreleme öncesi kaydın ta kendisi.
    const client = await createClient(agency.id, {
      instagramUserId: IG_USER_ID,
      instagramAccessToken: GERCEK_TOKEN,
    });
    expect(isEncrypted((await rawToken(client.id))!)).toBe(false);

    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
    });
    mockPublish.mockResolvedValue({ mediaId: "m1", permalink: "https://ig/p/1" });

    const outcome = await publishApprovedPost(post.id);
    expect(outcome.publishStatus).toBe("published");
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: GERCEK_TOKEN })
    );
  });
});

describe("çözülemeyen token sessizce geçmez", () => {
  it("yayın 'failed' olur ve sebebi panelde yazar", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id, {
      instagramUserId: IG_USER_ID,
      // Geçerli önek, bozuk içerik — anahtar değişmiş kaydı taklit eder.
      instagramAccessToken: "enc:v1:" + Buffer.alloc(64, 3).toString("base64"),
    });
    const { post } = await createPendingPostWithLink(agency.id, client.id, {
      status: "approved",
    });

    const outcome = await publishApprovedPost(post.id);
    expect(outcome.publishStatus).toBe("failed");
    expect(mockPublish).not.toHaveBeenCalled();

    const saved = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.publishError).toContain("çözülemedi");
  });

  it("furi uç noktası şifreli metni token diye VERMEZ, 500 döner", async () => {
    const agency = await createAgency();
    const client = await createClient(agency.id, {
      instagramUserId: IG_USER_ID,
      instagramAccessToken: "enc:v1:" + Buffer.alloc(64, 3).toString("base64"),
    });
    vi.stubEnv("FURI_API_AGENCY_ID", agency.id);
    mockAuth.mockResolvedValue(null as never);

    const res = await getToken(
      new Request("http://localhost/api/clients/x/instagram-token", {
        headers: { authorization: `Bearer ${API_KEY}` },
      }),
      params(client.id)
    );
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.code).toBe("token_undecryptable");
    // Sır ya da şifreli metin yanıta sızmamalı.
    expect(JSON.stringify(data)).not.toContain("enc:v1:");
  });
});
