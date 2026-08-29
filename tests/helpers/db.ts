import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { approvalLinkExpiry } from "@/lib/tokens";
import type { PostStatus, PublishStatus } from "@prisma/client";

export async function resetDb() {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "PostRevision", "ApprovalAudit", "ApprovalLink", "Post", "Client", "AgencyInvite", "AgencyMember", "Agency" CASCADE'
  );
}

/**
 * Ajans + `owner` rolünde BİR ÜYE (F6). İkisi birlikte üretiliyor çünkü
 * gerçekte üyesiz ajans yok: her ajans birinin giriş yapmasıyla doğuyor.
 * Üyesiz ajans kurmak, testleri prod'da imkânsız bir duruma göre yazmak
 * olurdu.
 */
export function createAgency(overrides: { name?: string; email?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const email = overrides.email ?? `agency-${suffix}@test.local`;
  return db.agency.create({
    data: {
      email,
      // `Agency.googleId` deprecate; eski kayıtları taklit etmek için hâlâ
      // doldurulabiliyor ama üyelik çözümü artık buraya BAKMIYOR.
      googleId: `google-${suffix}`,
      name: overrides.name ?? `Ajans ${suffix}`,
      members: {
        create: { googleId: `google-${suffix}`, email, role: "owner" },
      },
    },
    include: { members: true },
  });
}

/** Ajansa ek üye — çoklu owner / son owner testleri için. */
export function createMember(
  agencyId: string,
  overrides: { role?: "owner" | "member"; email?: string; googleId?: string } = {}
) {
  const suffix = randomUUID().slice(0, 8);
  return db.agencyMember.create({
    data: {
      agencyId,
      googleId: overrides.googleId ?? `google-${suffix}`,
      email: overrides.email ?? `uye-${suffix}@test.local`,
      role: overrides.role ?? "member",
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
    /** F8 — zamanlanmış yayın testleri için. */
    publishAt?: Date | null;
    /** Kaç tur revizyon yaşandığı (F10) — `revision_requested` testleri için. */
    revisionRound?: number;
    publishStatus?: PublishStatus;
    /** Reel postu: dolu ise gorsel URETILMEZ (bkz. validatePostMedia). */
    videoUrl?: string;
    /** Acilmis REELS container'i — devam ettirme testleri icin. */
    igContainerId?: string | null;
    containerAt?: Date | null;
  } = {}
) {
  const post = await db.post.create({
    data: {
      agencyId,
      clientId,
      caption: "Test caption",
      status: overrides.status ?? "pending",
      externalRef: overrides.externalRef ?? null,
      publishAt: overrides.publishAt ?? null,
      revisionRound: overrides.revisionRound ?? 0,
      publishStatus: overrides.publishStatus ?? "idle",
      videoUrl: overrides.videoUrl ?? null,
      igContainerId: overrides.igContainerId ?? null,
      containerAt: overrides.containerAt ?? null,
      images: overrides.videoUrl
        ? undefined
        : {
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
 * Müşterinin düzeltme istediği post (F10) — revizyon turunun ortasındaki hâl.
 * Zincirde müşteri satırı hazır durur ki ajans yolu gerçek veriyle test edilsin.
 */
export async function createRevisionRequestedPost(
  agencyId: string,
  clientId: string,
  overrides: {
    round?: number;
    message?: string | null;
    expiresAt?: Date;
    token?: string;
    publishStatus?: PublishStatus;
  } = {}
) {
  const round = overrides.round ?? 1;
  const { post, link } = await createPendingPostWithLink(agencyId, clientId, {
    status: "revision_requested",
    revisionRound: round,
    expiresAt: overrides.expiresAt,
    token: overrides.token,
    publishStatus: overrides.publishStatus,
  });
  const revision = await db.postRevision.create({
    data: {
      postId: post.id,
      round,
      actor: "client",
      event: "revision_requested",
      message: overrides.message === undefined ? "İkinci cümleyi değiştir" : overrides.message,
      caption: post.caption,
      ip: "9.9.9.9",
    },
  });
  return { post, link, revision };
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
