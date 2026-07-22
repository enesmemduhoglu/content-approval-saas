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

export function createClient(agencyId: string, overrides: { email?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  return db.client.create({
    data: {
      agencyId,
      name: `Müşteri ${suffix}`,
      email: overrides.email ?? `client-${suffix}@test.local`,
    },
  });
}

export async function createPendingPostWithLink(
  agencyId: string,
  clientId: string,
  overrides: { status?: PostStatus; expiresAt?: Date; token?: string } = {}
) {
  const post = await db.post.create({
    data: {
      agencyId,
      clientId,
      imageUrl: "/uploads/test.png",
      caption: "Test caption",
      status: overrides.status ?? "pending",
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
