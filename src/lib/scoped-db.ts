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
    // Client okumaları `ClientView` döner — token'ın yanlışlıkla bir yanıta ya
    // da prop'a sızması için önce bu dönüşümü bozmak gerekir. Tek istisna
    // `findInstagramCredentials`: adı ham token verdiğini söylesin diye ayrı.
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
       * Müşteri silme (F2). Postu olan müşteri SİLİNMEZ — `Post.clientId` FK'sı
       * zaten engellerdi ama o yol çıplak bir Prisma hatası verirdi; burada
       * sebep açıkça söyleniyor ve kaç post olduğu geri dönüyor ki ajans ne
       * yapması gerektiğini bilsin (önce postları sil).
       *
       * Silme, müşterinin Instagram kimlik bilgilerini de götürür (aynı satır) —
       * bağlantıyı ayrıca kaldırmak gerekmez.
       */
      deleteById: async (
        id: string
      ): Promise<
        { ok: true } | { ok: false; reason: "not_found" | "has_posts"; postCount?: number }
      > => {
        const client = await db.client.findFirst({
          where: { id, agencyId },
          select: { id: true, _count: { select: { posts: true } } },
        });
        if (!client) return { ok: false, reason: "not_found" };
        if (client._count.posts > 0) {
          return { ok: false, reason: "has_posts", postCount: client._count.posts };
        }
        // Kapsam burada da tekrarlanır: findFirst ile delete arasında geçen
        // sürede başka bir şey olduysa yanlış satıra dokunmayalım.
        const result = await db.client.deleteMany({ where: { id, agencyId } });
        return result.count === 1 ? { ok: true } : { ok: false, reason: "not_found" };
      },
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
       * ⚠ HAM TOKEN DÖNDÜREN TEK OKUMA YOLU — bilinçli ve tek amaçlı.
       *
       * `ClientView` token'ı bilerek maskeler; furi (ayrı repo, ayrı makine)
       * Instagram'a doğrudan konuşabilmek için ham token'a ihtiyaç duyuyor ve
       * kendi kopyasını tutması `refresh-instagram-tokens` cron'u token'ı
       * yenilediği anda bayatlıyordu. Kopyayı yok etmenin yolu, token'ı tek
       * kaynaktan (burası) dağıtmak.
       *
       * Kapsam yine `agencyId` ile: başka ajansın müşteri id'si verildiğinde
       * satır eşleşmez ve `null` döner — `findById` ile aynı IDOR koruması.
       * Bu yüzden ham `db.client` çağrısı route'ta DEĞİL, burada duruyor:
       * scoping'in unutulabileceği tek yer route katmanıdır.
       *
       * `select` dar tutulur: yalnızca yayın için gereken alanlar okunur.
       */
      findInstagramCredentials: async (
        id: string
      ): Promise<{
        id: string;
        name: string;
        instagramUserId: string | null;
        instagramAccessToken: string | null;
        instagramTokenExpiry: Date | null;
      } | null> =>
        db.client.findFirst({
          where: { id, agencyId },
          select: {
            id: true,
            name: true,
            instagramUserId: true,
            instagramAccessToken: true,
            instagramTokenExpiry: true,
          },
        }),
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
       * Post yönetimi işlemlerinin (link yenileme, mail tekrar gönderme)
       * ihtiyaç duyduğu okuma: müşteri + mevcut onay linki birlikte.
       * `client` dar `select`li — `instagramAccessToken` buraya da girmesin.
       */
      findByIdWithClientAndLink: (id: string) =>
        db.post.findFirst({
          where: { id, agencyId },
          include: {
            client: { select: { id: true, name: true, email: true } },
            approvalLink: true,
          },
        }),

      /**
       * Onay linkini yeniler: YENİ token + yeni son kullanma tarihi (F1).
       * Eski token o anda ölür — süresi dolmuş bir linki paylaşmaya devam etmek
       * ya da iki geçerli linkin dolaşımda kalması istenmez.
       *
       * `ApprovalLink.postId` unique olduğu için post başına tek satır var;
       * `updateMany` + `agencyId` filtresi yerine önce sahiplik doğrulanır
       * (link tablosunda `agencyId` yok, kapsam Post üzerinden gelir).
       */
      renewApprovalLink: async (
        id: string
      ): Promise<{ token: string; expiresAt: Date } | null> => {
        const post = await db.post.findFirst({
          where: { id, agencyId },
          select: { id: true },
        });
        if (!post) return null;

        const token = generateApprovalToken();
        const expiresAt = approvalLinkExpiry();
        // Link hiç yoksa (teorik: eski veri) oluştur, varsa değiştir.
        await db.approvalLink.upsert({
          where: { postId: post.id },
          update: { token, expiresAt },
          create: { postId: post.id, token, expiresAt },
        });
        return { token, expiresAt };
      },

      /**
       * Onay e-postasının sonucunu posta yazar (F5). Sonucu SAKLAMAK, yanıtta
       * döndürmekten farklı: panele bakan insan da "mail gitti mi" sorusunu
       * yanıtlayabilsin diye. Mail yolu hiçbir zaman akışı düşürmediğinden bu
       * yazma da sessizce başarısız olabilir — çağıran taraf await eder ama
       * hatayı yutar.
       */
      recordApprovalEmail: async (
        id: string,
        result: { sent: boolean; reason?: string }
      ): Promise<void> => {
        await db.post.updateMany({
          where: { id, agencyId },
          data: {
            approvalEmailSent: result.sent,
            approvalEmailError: result.sent ? null : (result.reason ?? "bilinmeyen"),
            approvalEmailSentAt: new Date(),
          },
        });
      },

      /**
       * Caption düzeltme (F2). YALNIZCA `pending` iken: karar verilmiş bir
       * postun metnini değiştirmek, müşterinin onayladığı şeyle kayıttaki şeyi
       * ayırır — onay kaydını sessizce yalan hâline getirir.
       */
      updateCaption: async (
        id: string,
        caption: string
      ): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_pending" }> => {
        const post = await db.post.findFirst({
          where: { id, agencyId },
          select: { status: true },
        });
        if (!post) return { ok: false, reason: "not_found" };
        if (post.status !== "pending") return { ok: false, reason: "not_pending" };

        const result = await db.post.updateMany({
          where: { id, agencyId, status: "pending" },
          data: { caption },
        });
        // Araya giren bir onay/red yarışı: satır eşleşmediyse artık pending değil.
        return result.count === 1 ? { ok: true } : { ok: false, reason: "not_pending" };
      },

      /**
       * Post silme (F2). Görsel URL'lerini döndürür ki çağıran taraf blob
       * dosyalarını da temizleyebilsin (F13) — DB satırı gidip dosya kalırsa
       * depolama sınırsız birikir.
       *
       * YAYINLANMIŞ POST SİLİNMEZ. Aynı kural `prod-test-verisi-temizligi.mjs`
       * betiğinde de var: Instagram'a gerçekten gitmiş bir içeriğin kaydını
       * silmek, "bu yayınlandı mı" sorusunu cevapsız bırakır ve mükerrer yayın
       * korumasının (`findLivePublishedTwin`) baktığı kardeş kaydı yok eder.
       *
       * `ApprovalAudit`'in Post'a FK'sı YOK (şemada ilişki tanımlı değil), yani
       * ne cascade eder ne engeller — elle silinmezse öksüz satır kalır.
       */
      deleteById: async (
        id: string
      ): Promise<
        { ok: true; imageUrls: string[] } | { ok: false; reason: "not_found" | "published" }
      > => {
        const post = await db.post.findFirst({
          where: { id, agencyId },
          select: { id: true, publishStatus: true, images: { select: { url: true } } },
        });
        if (!post) return { ok: false, reason: "not_found" };
        if (post.publishStatus === "published") return { ok: false, reason: "published" };

        const imageUrls = post.images.map((image) => image.url);
        await db.$transaction(async (tx) => {
          await tx.approvalAudit.deleteMany({ where: { postId: post.id } });
          await tx.postImage.deleteMany({ where: { postId: post.id } });
          await tx.approvalLink.deleteMany({ where: { postId: post.id } });
          // Kapsam son adımda da tekrarlanır — transaction içinde bile.
          await tx.post.deleteMany({ where: { id: post.id, agencyId } });
        });
        return { ok: true, imageUrls };
      },
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
