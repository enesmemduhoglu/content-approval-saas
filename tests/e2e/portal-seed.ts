import { E2E_AUTH_SECRET, E2E_DATABASE_URL, FAKE_QSTASH_URL } from "../../playwright.config";

// Test süreci uygulama modüllerini (`db`, `createLoginToken`) doğrudan kullanıyor.
// Playwright `.env` yüklemez ama Prisma yükler: env burada ayarlanmasaydı kayıtlar
// `.env`'deki YEREL dev veritabanına, giriş kodu da sunucunun bilmediği bir
// anahtarla yazılırdı. Bu yüzden modüller env ayarlandıktan SONRA, dinamik
// import ile yükleniyor.
process.env.DATABASE_URL = E2E_DATABASE_URL;
process.env.AUTH_SECRET = E2E_AUTH_SECRET;

async function modules() {
  const [{ db }, dbHelpers, portalHelpers, clientAuth] = await Promise.all([
    import("../../src/lib/db"),
    import("../helpers/db"),
    import("../helpers/portal"),
    import("../../src/lib/client-auth"),
  ]);
  return { db, ...dbHelpers, ...portalHelpers, ...clientAuth };
}

/** Kendi ajansı, müşterisi ve portal kullanıcısıyla bağımsız bir dünya. */
export async function seedPortalClient() {
  const m = await modules();
  const agency = await m.createAgency();
  const client = await m.createClient(agency.id);
  const user = await m.createClientUser(client.id);
  return { agencyId: agency.id, clientId: client.id, user };
}

/**
 * Yüklemesi tamamlanmış bir portal videosu. Gerçek yükleme bu testin kapsamı
 * DEĞİL: `complete` R2'de nesneyi `HeadObject` ile arıyor ve e2e'de R2 bilerek
 * kapalı (prod bucket'ı). Ayrı bir adım olarak TODOS'ta.
 */
export async function seedVideo(
  agencyId: string,
  clientId: string,
  overrides: Parameters<Awaited<ReturnType<typeof modules>>["createPortalPost"]>[2] = {}
) {
  const m = await modules();
  return m.createPortalPost(agencyId, clientId, overrides);
}

/** `updatedAt`i geriye çeker — Prisma `@updatedAt`i her yazmada ezdiği için ham SQL. */
export async function ageVideo(postId: string, minutes: number) {
  const { db } = await modules();
  await db.$executeRaw`UPDATE "Post" SET "updatedAt" = now() - make_interval(mins => ${minutes}::int) WHERE id = ${postId}`;
}

export async function readVideo(postId: string) {
  const { db } = await modules();
  return db.post.findUniqueOrThrow({
    where: { id: postId },
    select: { status: true, caption: true, captionStatus: true, updatedAt: true },
  });
}

/**
 * Giriş kodu. E-posta adımı ("Kod gönder") YENİ bir token üretir ve
 * `consumeLoginCode` yalnızca en sonuncuyu dener; bu kod ya "Kodum var"
 * yoluyla ya da e-posta adımından SONRA üretilerek kullanılmalı.
 */
export async function loginCode(clientUserId: string): Promise<string> {
  const { createLoginToken } = await modules();
  return (await createLoginToken(clientUserId)).code;
}

export type FakeQStashMessage = { messageId: string; destination: string; body: unknown };

export async function qstashMessages(): Promise<FakeQStashMessage[]> {
  return (await fetch(`${FAKE_QSTASH_URL}/__e2e/messages`)).json();
}

export async function resetQStash(): Promise<void> {
  await fetch(`${FAKE_QSTASH_URL}/__e2e/messages`, { method: "DELETE" });
}
