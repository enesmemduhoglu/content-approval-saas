import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { approvalLinkExpiry } from "@/lib/tokens";
import type { PostStatus } from "@prisma/client";

export async function resetDb() {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "ApprovalAudit", "ApprovalLink", "Post", "Client", "Agency" CASCADE'
  );
}

export function createAgency(overrides: { name?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  return db.agency.create({
    data: {
      email: `agency-${suffix}@test.local`,
      googleId: `google-${suffix}`,
      name: overrides.name ?? `Ajans ${suffix}`,
    },
  });
}

export function createClient(
  agencyId: string,
  overrides: {
    email?: string;
    instagramUserId?: string;
    instagramAccessToken?: string;
    instagramTokenExpiry?: Date;
  } = {}
) {
  const suffix = randomUUID().slice(0, 8);
  return db.client.create({
    data: {
      agencyId,
      name: `Müşteri ${suffix}`,
      email: overrides.email ?? `client-${suffix}@test.local`,
      instagramUserId: overrides.instagramUserId ?? null,
      instagramAccessToken: overrides.instagramAccessToken ?? null,
      instagramTokenExpiry: overrides.instagramTokenExpiry ?? null,
    },
  });
}

/** Instagram bağlı müşteri — yayın akışı testleri için. */
export function createInstagramClient(agencyId: string) {
  return createClient(agencyId, {
    instagramUserId: "17841400000000000",
    instagramAccessToken: "IGAA-test-token",
  });
}

export async function createPendingPostWithLink(
  agencyId: string,
  clientId: string,
  overrides: {
    status?: PostStatus;
    expiresAt?: Date;
    token?: string;
    imageUrls?: string[];
    /** Dış sistemin (furi) tanımlayıcısı — mükerrer yayın koruması testleri için. */
    externalRef?: string;
  } = {}
) {
  const post = await db.post.create({
    data: {
      agencyId,
      clientId,
      caption: "Test caption",
      status: overrides.status ?? "pending",
      externalRef: overrides.externalRef ?? null,
      images: {
        create: (overrides.imageUrls ?? ["/uploads/test.png"]).map((url, index) => ({
          url,
          sortOrder: index,
        })),
      },
    },
  });
  const link = await db.approvalLink.create({
    data: {
      postId: post.id,
      token: overrides.token ?? randomUUID().replace(/-/g, ""),
      expiresAt: overrides.expiresAt ?? approvalLinkExpiry(),
    },
  });
  return { post, link };
}

/**
 * Instagram'a yayınlanmış post — mükerrer yayın korumasının baktığı "kardeş"
 * kaydın ta kendisi. Onay linki yok: yayın kontrolü linkten değil,
 * (agencyId, externalRef) çiftinden gidiyor.
 */
export function createPublishedPost(
  agencyId: string,
  clientId: string,
  overrides: {
    externalRef?: string;
    igMediaId?: string | null;
    igPermalink?: string | null;
  } = {}
) {
  return db.post.create({
    data: {
      agencyId,
      clientId,
      caption: "Yayınlanmış caption",
      status: "approved",
      publishStatus: "published",
      externalRef: overrides.externalRef ?? null,
      igMediaId: overrides.igMediaId === undefined ? "media-eski" : overrides.igMediaId,
      igPermalink:
        overrides.igPermalink === undefined
          ? "https://instagram.com/p/ESKI/"
          : overrides.igPermalink,
      publishedAt: new Date(),
      images: { create: [{ url: "/uploads/eski.png", sortOrder: 0 }] },
    },
  });
}
