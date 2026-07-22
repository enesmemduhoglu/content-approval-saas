import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { approvalLinkExpiry, generateApprovalToken } from "@/lib/tokens";

export type ScopedSession = { agencyId: string };

export class ClientNotOwnedError extends Error {
  constructor() {
    super("Bu müşteri bulunamadı");
  }
}

/**
 * Tüm Client/Post sorgularına otomatik `agencyId` filtresi enjekte eden sarmalayıcı (D5).
 * Route handler'lar bu modeller için asla ham `db.*` çağırmaz — IDOR'a karşı
 * merkezi koruma budur; yeni endpoint eklendiğinde scoping unutulamaz.
 */
export function getScopedDb(session: ScopedSession) {
  const { agencyId } = session;
  return {
    agencyId,
    clients: {
      findMany: (args: { orderBy?: Prisma.ClientOrderByWithRelationInput } = {}) =>
        db.client.findMany({ ...args, where: { agencyId } }),
      findById: (id: string) => db.client.findFirst({ where: { id, agencyId } }),
      create: (data: { name: string; email: string }) =>
        db.client.create({ data: { ...data, agencyId } }),
    },
    posts: {
      findMany: (
        args: { orderBy?: Prisma.PostOrderByWithRelationInput } = {}
      ) => db.post.findMany({ ...args, where: { agencyId } }),
      /** Dashboard listesi: `client` + `approvalLink` eager-load edilir — N+1 yok (T4). */
      findManyWithRelations: (
        args: { orderBy?: Prisma.PostOrderByWithRelationInput } = {}
      ) =>
        db.post.findMany({
          ...args,
          where: { agencyId },
          include: { client: true, approvalLink: true },
        }),
      findById: (id: string) => db.post.findFirst({ where: { id, agencyId } }),
      /**
       * Post + ApprovalLink'i tek transaction'da oluşturur — ikinci yazma başarısız
       * olursa ilki geri alınır, approval linki olmayan yarım post kalmaz (T2).
       * clientId bu ajansa ait değilse ClientNotOwnedError fırlatır (T1).
       */
      createWithApprovalLink: async (input: {
        clientId: string;
        imageUrl: string;
        caption: string;
      }) => {
        const client = await db.client.findFirst({
          where: { id: input.clientId, agencyId },
        });
        if (!client) throw new ClientNotOwnedError();

        const token = generateApprovalToken();
        const expiresAt = approvalLinkExpiry();

        const { post, approvalLink } = await db.$transaction(async (tx) => {
          const post = await tx.post.create({
            data: {
              agencyId,
              clientId: input.clientId,
              imageUrl: input.imageUrl,
              caption: input.caption,
              status: "pending",
            },
          });
          const approvalLink = await tx.approvalLink.create({
            data: { postId: post.id, token, expiresAt },
          });
          return { post, approvalLink };
        });

        return { post, approvalLink, client };
      },
    },
  };
}
