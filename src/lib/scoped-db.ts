import type { Client, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isPublishTarget, type TokenAlertClient } from "@/lib/instagram-token";
import { approvalLinkExpiry, generateApprovalToken } from "@/lib/tokens";

export type ScopedSession = { agencyId: string };

export class ClientNotOwnedError extends Error {
  constructor() {
    super("Bu müşteri bulunamadı");
  }
}

/**
 * Client kaydının dışarı çıkabilen hâli. `instagramAccessToken` BİLEREK yok:
 * sır ne API yanıtında ne de server component prop'unda ham geçer. Yerine
 * "bağlı mı" bilgisi ve son 4 karakterlik ipucu döner — ajans hangi token'ın
 * kayıtlı olduğunu ayırt edebilsin ama token yeniden ele geçirilemesin.
 */
export type ClientView = {
  id: string;
  agencyId: string;
  name: string;
  email: string;
  createdAt: Date;
  instagramUserId: string | null;
  instagramTokenExpiry: Date | null;
  instagramConnected: boolean;
  /** "…AbCd" — token kayıtlıysa son 4 karakter, değilse null. */
  instagramTokenHint: string | null;
};

export function toClientView(client: Client): ClientView {
  const token = client.instagramAccessToken;
  return {
    id: client.id,
    agencyId: client.agencyId,
    name: client.name,
    email: client.email,
    createdAt: client.createdAt,
    instagramUserId: client.instagramUserId,
    instagramTokenExpiry: client.instagramTokenExpiry,
    instagramConnected: Boolean(client.instagramUserId && token),
    instagramTokenHint: token ? `…${token.slice(-4)}` : null,
  };
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
    // Client okumaları daima `ClientView` döner — token'ın yanlışlıkla bir
    // yanıta ya da prop'a sızması için önce bu dönüşümü bozmak gerekir.
    clients: {
      findMany: async (
        args: { orderBy?: Prisma.ClientOrderByWithRelationInput } = {}
      ): Promise<ClientView[]> =>
        (await db.client.findMany({ ...args, where: { agencyId } })).map(toClientView),
      findById: async (id: string): Promise<ClientView | null> => {
        const client = await db.client.findFirst({ where: { id, agencyId } });
        return client ? toClientView(client) : null;
      },
      create: async (data: { name: string; email: string }): Promise<ClientView> =>
        toClientView(await db.client.create({ data: { ...data, agencyId } })),
      /**
       * Instagram kimlik bilgilerini yazar/temizler. `updateMany` + `agencyId`
       * filtresi bilinçli: başka ajansın müşterisi verildiğinde satır eşleşmez,
       * güncelleme sessizce hiçbir şey yapmaz ve `null` döner (IDOR yok).
       */
      updateInstagram: async (
        id: string,
        data: {
          instagramUserId: string | null;
          instagramAccessToken: string | null;
          instagramTokenExpiry: Date | null;
        }
      ): Promise<ClientView | null> => {
        const result = await db.client.updateMany({ where: { id, agencyId }, data });
        if (result.count === 0) return null;
        const client = await db.client.findFirst({ where: { id, agencyId } });
        return client ? toClientView(client) : null;
      },
      /**
       * Dashboard token uyarısı için müşteri listesi. Instagram'ı bağlı olmayan
       * müşteriler SQL'de elenir; erişim token'ının kendisi bilerek `select`
       * edilmez — sır olduğu için sunucu belleğine de, prop'a da girmemeli.
       * (`ClientView`'dan ayrı duruyor: o token'ı okuyup maskeliyor, bu hiç okumuyor.)
       */
      withInstagramTokenExpiry: async (): Promise<TokenAlertClient[]> => {
        const rows = await db.client.findMany({
          where: {
            agencyId,
            instagramUserId: { not: null },
            instagramAccessToken: { not: null },
            instagramTokenExpiry: { not: null },
          },
          select: { id: true, name: true, instagramTokenExpiry: true },
          orderBy: { instagramTokenExpiry: "asc" },
        });
        // `where` zaten bağlı olmayanları eledi.
        return rows.map((row) => ({ ...row, instagramConnected: true }));
      },
    },
    posts: {
      findMany: (
        args: { orderBy?: Prisma.PostOrderByWithRelationInput } = {}
      ) => db.post.findMany({ ...args, where: { agencyId } }),
      /**
       * Dashboard listesi: `client` + `approvalLink` + `images` eager-load edilir — N+1 yok (T4).
       * `client` bilerek `select`li: tam kayıt eager-load edilirse
       * `instagramAccessToken` de GET /api/posts yanıtına düşer.
       *
       * Panelin "onaylandı ama yayınlanmadı" rozetine karar verebilmesi için
       * Instagram alanları okunur, ama dışarı `publishTarget` boolean'ı çıkar.
       * Yüklem `instagram-token.ts`'deki tek tanımdan gelir — panel ile toplu
       * onay yolunun aynı soruya farklı yanıt vermesi mümkün olmasın.
       */
      findManyWithRelations: async (
        args: { orderBy?: Prisma.PostOrderByWithRelationInput } = {}
      ) => {
        const posts = await db.post.findMany({
          ...args,
          where: { agencyId },
          include: {
            client: {
              // Instagram alanları "yayın hedefi mi?" sorusunu yanıtlamak için
              // okunur ama aşağıda DÜŞÜRÜLÜR — token yanıta asla girmez.
              select: {
                id: true,
                name: true,
                email: true,
                instagramUserId: true,
                instagramAccessToken: true,
              },
            },
            approvalLink: true,
            images: { orderBy: { sortOrder: "asc" } },
          },
        });
        return posts.map(({ client, ...post }) => {
          const { instagramUserId: _u, instagramAccessToken: _t, ...safe } = client;
          return { ...post, client: { ...safe, publishTarget: isPublishTarget(client) } };
        });
      },
      findById: (id: string) => db.post.findFirst({ where: { id, agencyId } }),
      /**
       * Post + görseller + ApprovalLink'i tek transaction'da oluşturur — herhangi
       * bir yazma başarısız olursa tümü geri alınır (T2). clientId bu ajansa ait
       * değilse ClientNotOwnedError fırlatır (T1).
       */
      createWithApprovalLink: async (input: {
        clientId: string;
        imageUrls: string[];
        caption: string;
        /** Instagram alt_text'leri — `imageUrls` ile aynı sırada, opsiyonel. */
        altTexts?: (string | null | undefined)[];
        /** Dış sistemin kendi tanımlayıcısı (furi slug'ı). */
        externalRef?: string | null;
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
              caption: input.caption,
              status: "pending",
              externalRef: input.externalRef ?? null,
            },
          });
          await tx.postImage.createMany({
            data: input.imageUrls.map((url, index) => ({
              postId: post.id,
              url,
              altText: input.altTexts?.[index] ?? null,
              sortOrder: index,
            })),
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
