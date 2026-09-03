import type { AgencyRole, Client, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeEmail } from "@/lib/membership";
import { decryptSecret, encryptSecret, tryDecryptSecret } from "@/lib/crypto";
import { isPublishTarget, type TokenAlertClient } from "@/lib/instagram-token";
import {
  approvalLinkExpiry,
  generateApprovalToken,
  generateInviteToken,
  inviteExpiry,
} from "@/lib/tokens";

export type ScopedSession = { agencyId: string };

export class ClientNotOwnedError extends Error {
  constructor() {
    super("Bu müşteri bulunamadı");
  }
}

/** F6 — ekip yönetimi işlemlerinin dönüş sözleşmesi. */
export type MemberView = {
  id: string;
  email: string;
  name: string | null;
  role: AgencyRole;
  createdAt: Date;
};

export type InviteView = {
  id: string;
  email: string;
  role: AgencyRole;
  expiresAt: Date;
  invitedByEmail: string | null;
  createdAt: Date;
  /** Token yanıta ÇIKMAZ; panelin bilmesi gereken tek şey davetin ölü olup olmadığı. */
  expired: boolean;
};

export type InviteCreateFailure =
  | "already_member"
  | "already_invited"
  | "invite_quota";

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
  const stored = client.instagramAccessToken;
  // İpucu ŞİFRELİ metinden değil, ÇÖZÜLMÜŞ token'dan üretilmeli — yoksa ajansa
  // base64 kuyruğu gösterilir ve "hangi token kayıtlı" sorusu yanıtsız kalır.
  // `tryDecrypt` bilinçli: çözülemeyen bir sır yüzünden müşteri listesi komple
  // düşmemeli. Bağlantının VARLIĞI ham kayda bakar (satırda token var), ipucu
  // ise ancak çözülebiliyorsa gösterilir.
  const token = stored ? tryDecryptSecret(stored) : null;
  if (stored && token === null) {
    console.error(
      `[scoped-db] ${client.id} müşterisinin Instagram token'ı çözülemedi — ` +
        "ENCRYPTION_KEY değişmiş ya da kayıt bozulmuş olabilir. Yayın çalışmayacak."
    );
  }
  return {
    id: client.id,
    agencyId: client.agencyId,
    name: client.name,
    email: client.email,
    createdAt: client.createdAt,
    instagramUserId: client.instagramUserId,
    instagramTokenExpiry: client.instagramTokenExpiry,
    instagramConnected: Boolean(client.instagramUserId && stored),
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
       * Kota kontrolü (F7) için ajans kapsamlı sayım. Ham `db.client.count`
       * route'ta çağrılmaz — o zaman `agencyId` filtresi unutulabilir ve kota
       * yanlışlıkla TÜM ajansların toplamına bakar (kendi başına bir IDOR/DoS
       * çeşidi: bir ajans başkasının kullanımı yüzünden tavana çarpar).
       */
      count: async (): Promise<number> => db.client.count({ where: { agencyId } }),

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
        // Token ŞİFRELENEREK yazılır (S1) — DB'ye düz metin girmesinin tek yolu
        // buydu. `null` (bağlantı kaldırma) olduğu gibi geçer.
        const result = await db.client.updateMany({
          where: { id, agencyId },
          data: {
            ...data,
            instagramAccessToken:
              data.instagramAccessToken === null
                ? null
                : encryptSecret(data.instagramAccessToken),
          },
        });
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
      } | null> => {
        const client = await db.client.findFirst({
          where: { id, agencyId },
          select: {
            id: true,
            name: true,
            instagramUserId: true,
            instagramAccessToken: true,
            instagramTokenExpiry: true,
          },
        });
        if (!client) return null;
        // Token ÇÖZÜLMÜŞ döner: bu yolun tüketicisi (furi) onu doğrudan
        // Instagram'a veriyor. Çözme hatası burada YUTULMAZ — `SecretCryptoError`
        // çağırana kadar gider; şifreli metni token sanıp göndermek, teşhisi
        // imkânsız bir "Instagram kabul etmedi" hatasına dönerdi.
        return {
          ...client,
          instagramAccessToken: client.instagramAccessToken
            ? decryptSecret(client.instagramAccessToken)
            : null,
        };
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
            // Karar geçmişi (F4). `ApprovalAudit` yazılıyordu ama hiçbir yerde
            // OKUNMUYORDU — README'nin "karar IP ve zaman damgasıyla kayıt
            // altında" vaadinin arayüzde karşılığı yoktu. İlişki de bu yüzden
            // eklendi; öncesinde `postId` çıplak bir String olduğu için
            // `include` mümkün değildi.
            audits: {
              select: { id: true, action: true, ip: true, createdAt: true },
              orderBy: { createdAt: "asc" },
            },
            // Revizyon zinciri (F10). Karar geçmişinden AYRI okunuyor: o "ne
            // karar verildi", bu "ne konuşuldu ve metin nasıl değişti".
            revisions: {
              select: {
                id: true,
                round: true,
                actor: true,
                event: true,
                message: true,
                caption: true,
                createdAt: true,
              },
              orderBy: { createdAt: "asc" },
            },
          },
        });
        return posts.map(({ client, ...post }) => {
          const { instagramUserId: _u, instagramAccessToken: _t, ...safe } = client;
          return { ...post, client: { ...safe, publishTarget: isPublishTarget(client) } };
        });
      },
      findById: (id: string) => db.post.findFirst({ where: { id, agencyId } }),
      /** Kota kontrolü (F7) için ajans kapsamlı sayım — bkz. `clients.count`. */
      count: async (): Promise<number> => db.post.count({ where: { agencyId } }),
      /**
       * Kayan pencere içinde açılan post sayısı (F7, hız tavanı).
       *
       * `createdAt` kullanılıyor çünkü tüketilen kaynak postun KAYIT ANINDA
       * yaratılıyor (Blob'a görseller o an yazılıyor); postun sonraki durumu
       * — onaylanması, reddedilmesi, hatta silinmesi — bu tüketimi geri
       * almıyor. Silinen post sayımdan düşer ve bu bilinçli: F13 ile silinen
       * postun blob'ları da siliniyor, yani kaynak gerçekten geri veriliyor.
       */
      countSince: async (since: Date): Promise<number> =>
        db.post.count({ where: { agencyId, createdAt: { gte: since } } }),

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
       * Revizyon sayfasının okuması (F10): ajans postu düzeltirken müşterinin
       * ne istediğini, o an yayında olan görselleri ve turun geçmişini bir
       * arada görmeli. `findByIdWithClientAndLink` yetmez (görsel ve zincir
       * taşımıyor), dashboard'ın `findManyWithRelations`ı ise tek post için
       * ajansın TÜM postlarını çekerdi.
       *
       * `client` dar `select`li — bu ekranın müşteriden ihtiyacı yalnızca ad.
       */
      findByIdForRevision: (id: string) =>
        db.post.findFirst({
          where: { id, agencyId },
          include: {
            client: { select: { id: true, name: true } },
            images: { orderBy: { sortOrder: "asc" } },
            revisions: {
              select: {
                id: true,
                round: true,
                actor: true,
                event: true,
                message: true,
                caption: true,
                createdAt: true,
              },
              orderBy: { createdAt: "asc" },
            },
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
      /**
       * Onay bekleyen postun metnini ve/veya görsellerini SESSİZCE günceller
       * (F2 + panel düzenleme sayfası): durum değişmez, müşteriye mail gitmez.
       * Revizyon turunun (`resubmitForApproval`) tersi — orada iş bir durum
       * geçişi ve bildirim, burada yalnızca ajansın kendi yazım düzeltmesi.
       *
       * SADECE `pending` iken çalışır. Karar verilmiş postun metnini
       * değiştirmek, müşterinin onayladığı şeyle kayıttaki şeyi ayırır.
       *
       * `imageUrls` verilmezse görsellere DOKUNULMAZ; verilirse tamamı
       * değişir ve yerini kaybedenler `removedImageUrls`te döner (blob
       * temizliği çağıranın işi, F13).
       */
      updatePending: async (input: {
        id: string;
        caption?: string;
        imageUrls?: string[];
      }): Promise<
        | { ok: true; removedImageUrls: string[] }
        | { ok: false; reason: "not_found" | "not_pending" }
      > => {
        const post = await db.post.findFirst({
          where: { id: input.id, agencyId },
          select: { status: true, images: { select: { url: true }, orderBy: { sortOrder: "asc" } } },
        });
        if (!post) return { ok: false, reason: "not_found" };
        if (post.status !== "pending") return { ok: false, reason: "not_pending" };

        const replacingImages = input.imageUrls !== undefined;
        const committed = await db.$transaction(async (tx) => {
          // Araya giren bir onay/red yarışı: satır eşleşmediyse artık pending değil.
          const result = await tx.post.updateMany({
            where: { id: input.id, agencyId, status: "pending" },
            data: input.caption === undefined ? {} : { caption: input.caption },
          });
          if (result.count === 0) return false;

          if (replacingImages) {
            await tx.postImage.deleteMany({ where: { postId: input.id } });
            await tx.postImage.createMany({
              data: input.imageUrls!.map((url, index) => ({
                postId: input.id,
                url,
                sortOrder: index,
              })),
            });
          }
          return true;
        });

        if (!committed) return { ok: false, reason: "not_pending" };
        return {
          ok: true,
          removedImageUrls: replacingImages ? post.images.map((image) => image.url) : [],
        };
      },

      /**
       * Düzeltip yeniden onaya gönderme (F10) — revizyon turunun ajans yarısı.
       *
       * SADECE `revision_requested` iken çalışır. `pending`den çağrılsa mevcut
       * onay isteğini sessizce ikinci kez başlatırdı; `approved`/`rejected`ten
       * çağrılsa müşterinin verdiği kararın altındaki metni değiştirirdi —
       * `updateCaption`'ın kapattığı deliğin aynısı.
       *
       * ONAY LİNKİ AYNI TOKEN'LA DEVAM EDER. Bilinçli tercih: revizyon aynı
       * işin devamı, yeni bir iş değil. Müşterinin en doğal refleksi elindeki
       * maildeki linke tekrar tıklamaktır; token değiştirilseydi o link ölür ve
       * müşteri "az önce çalışıyordu" diyerek duvara çarpardı. Sadece SÜRE
       * tazelenir — konuşma sürerken linkin ölmesi turun kendisini keserdi.
       * (F1'deki `renewApprovalLink` tam tersini yapar ve orada doğrusu odur:
       * amacı sızmış bir linki İPTAL etmek.)
       *
       * Yayınlanmış post buraya giremez: `publishStatus` guard'ı UPDATE'in
       * WHERE'inde de tekrarlanır — DB'deki metni değiştirip Instagram'daki
       * gönderiyi olduğu gibi bırakmak, panelle gerçekliği sessizce ayırırdı.
       */
      resubmitForApproval: async (input: {
        id: string;
        /** Yeni metin; verilmezse mevcut metin korunur. */
        caption?: string;
        /** Yeni görsel URL'leri; verilmezse görseller olduğu gibi kalır. */
        imageUrls?: string[];
        altTexts?: (string | null | undefined)[];
        /** Ajansın "şunu değiştirdim" notu. */
        message?: string | null;
      }): Promise<
        | {
            ok: true;
            round: number;
            caption: string;
            token: string;
            expiresAt: Date;
            client: { id: string; name: string; email: string };
            /** Müşterinin bu turda ne istediği — bildirime geri konur. */
            lastRequest: string | null;
            /** Yerini yenilerine bırakan görseller — blob temizliği çağıranın işi. */
            removedImageUrls: string[];
          }
        | {
            ok: false;
            reason: "not_found" | "not_revision_requested" | "published";
            status?: string;
          }
      > => {
        const post = await db.post.findFirst({
          where: { id: input.id, agencyId },
          include: {
            client: { select: { id: true, name: true, email: true } },
            approvalLink: true,
            images: { select: { url: true }, orderBy: { sortOrder: "asc" } },
            revisions: {
              where: { event: "revision_requested" },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        });
        if (!post) return { ok: false, reason: "not_found" };
        // Yayın kontrolü durum kontrolünden ÖNCE: hata mesajı "yayınlanmış" mı
        // "revizyon beklemiyor" mu, ajansa doğrusu söylensin.
        if (post.publishStatus === "published") return { ok: false, reason: "published" };
        if (post.status !== "revision_requested") {
          return { ok: false, reason: "not_revision_requested", status: post.status };
        }

        const caption = input.caption ?? post.caption;
        const replacingImages = input.imageUrls !== undefined;
        const oldImageUrls = post.images.map((image) => image.url);

        // Link aynı token'la yaşamaya devam eder; yoksa (teorik: eski veri)
        // oluşturulur. Süre her turda tazelenir.
        const token = post.approvalLink?.token ?? generateApprovalToken();
        const expiresAt = approvalLinkExpiry();

        const committed = await db.$transaction(async (tx) => {
          // Yarış koruması: `updateCaption`/onay yolundaki desenin aynısı. Aynı
          // anda gelen ikinci "tekrar gönder" ya da araya giren bir karar
          // olduğunda satır eşleşmez ve tur ikinci kez açılmaz.
          const result = await tx.post.updateMany({
            where: {
              id: input.id,
              agencyId,
              status: "revision_requested",
              publishStatus: { not: "published" },
            },
            data: {
              status: "pending",
              caption,
              // Bu tur için verilmiş bir red gerekçesi yok; eski turdan kalan
              // metnin panelde asılı kalması yanlış bilgi olurdu.
              rejectionReason: null,
              // Hatırlatmalar TEK SEFERLİK ve postun ömrüne bağlı. Yeni tur yeni
              // bir bekleyiştir: sıfırlanmasaydı bu turda müşteri hiç
              // dürtülmezdi (F3 sayaçları `null` = "henüz gitmedi" demek).
              reminderSentAt: null,
              expiryNoticeSentAt: null,
            },
          });
          if (result.count === 0) return false;

          if (replacingImages) {
            await tx.postImage.deleteMany({ where: { postId: input.id } });
            await tx.postImage.createMany({
              data: input.imageUrls!.map((url, index) => ({
                postId: input.id,
                url,
                altText: input.altTexts?.[index] ?? null,
                sortOrder: index,
              })),
            });
          }

          await tx.approvalLink.upsert({
            where: { postId: input.id },
            update: { expiresAt },
            create: { postId: input.id, token, expiresAt },
          });

          await tx.postRevision.create({
            data: {
              postId: input.id,
              round: post.revisionRound,
              actor: "agency",
              event: "resubmitted",
              message: input.message ?? null,
              caption,
            },
          });
          return true;
        });

        if (!committed) {
          const current = await db.post.findFirst({
            where: { id: input.id, agencyId },
            select: { status: true },
          });
          return {
            ok: false,
            reason: "not_revision_requested",
            status: current?.status,
          };
        }

        return {
          ok: true,
          round: post.revisionRound,
          caption,
          token,
          expiresAt,
          client: post.client,
          lastRequest: post.revisions[0]?.message ?? null,
          // Yalnızca GERÇEKTEN yerini kaybeden görseller dönüyor: değişiklik
          // yoksa liste boş, yoksa çağıran taraf hâlâ kullanılan dosyaları siler.
          removedImageUrls: replacingImages ? oldImageUrls : [],
        };
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
          // `PostRevision`'ın FK'sı RESTRICT: elle silinmezse post silme yolu
          // çıplak bir Prisma hatasıyla düşerdi (F10).
          await tx.postRevision.deleteMany({ where: { postId: post.id } });
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
        /** F8: doluysa ve onay anında gelecekteyse yayın crona bırakılır. */
        publishAt?: Date | null;
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
              publishAt: input.publishAt ?? null,
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

    /**
     * F6 — ekip üyeleri. Client/Post ile AYNI gerekçeyle burada: route
     * handler'lar `db.agencyMember.*` çağırmaz. Üyelik sorguları en az
     * müşteri sorguları kadar IDOR'a açık — "üye id'si" gövdeden geliyor ve
     * kapsam filtresi unutulursa bir ajans başka ajansın ekibini çıkarabilir.
     */
    members: {
      findMany: async (): Promise<MemberView[]> =>
        db.agencyMember.findMany({
          where: { agencyId },
          // owner'lar üstte, sonra katılım sırası — panelde okunaklı bir düzen.
          orderBy: [{ role: "asc" }, { createdAt: "asc" }],
          select: { id: true, email: true, name: true, role: true, createdAt: true },
        }),

      count: async (): Promise<number> => db.agencyMember.count({ where: { agencyId } }),

      /**
       * Üye çıkarma. `owner`ın SON owner olması durumu burada, tek bir
       * transaction içinde çözülüyor — route katmanında "önce say, sonra sil"
       * yapılsaydı iki owner'ın aynı anda birbirini çıkarması ajansı sahipsiz
       * bırakabilirdi (ikisi de "2 owner var" okur, ikisi de siler).
       *
       * Sahipsiz ajans teorik bir kayıp değil: kimse davet edemez, kimse üye
       * çıkaramaz ve ajansı kurtarmanın panelden hiçbir yolu kalmaz.
       */
      removeById: async (
        id: string
      ): Promise<
        { ok: true } | { ok: false; reason: "not_found" | "last_owner" }
      > =>
        db.$transaction(async (tx) => {
          const member = await tx.agencyMember.findFirst({
            where: { id, agencyId },
            select: { id: true, role: true },
          });
          // Kapsam dışı bir id "yetkin yok" değil "yok" döner: başka ajansta
          // böyle bir üyenin VAR OLDUĞU bilgisi bile sızmasın.
          if (!member) return { ok: false, reason: "not_found" as const };

          if (member.role === "owner") {
            const ownerCount = await tx.agencyMember.count({
              where: { agencyId, role: "owner" },
            });
            if (ownerCount <= 1) return { ok: false, reason: "last_owner" as const };
          }

          const result = await tx.agencyMember.deleteMany({ where: { id, agencyId } });
          return result.count === 1
            ? { ok: true as const }
            : { ok: false, reason: "not_found" as const };
        }),
    },

    /** F6 — bekleyen davetler. Kapsam gerekçesi `members` ile birebir aynı. */
    invites: {
      /** Panelde gösterilen liste: yalnızca KABUL EDİLMEMİŞ davetler. */
      findPending: async (): Promise<InviteView[]> => {
        const now = new Date();
        const rows = await db.agencyInvite.findMany({
          where: { agencyId, acceptedAt: null },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            email: true,
            role: true,
            expiresAt: true,
            invitedByEmail: true,
            createdAt: true,
          },
        });
        // Süresi dolmuş davet listeden DÜŞÜRÜLMÜYOR, işaretleniyor: ajans
        // "davet ettim ama gelmedi" durumunu görüp yeniden davet edebilsin.
        return rows.map((row) => ({
          ...row,
          expired: row.expiresAt.getTime() <= now.getTime(),
        }));
      },

      /**
       * Davet oluşturur. Token'ı DÖNDÜRÜR (mail linki için) ama `InviteView`
       * içine koymaz — panelin listelediği hiçbir yanıtta token geçmesin.
       */
      create: async (input: {
        email: string;
        role: AgencyRole;
        invitedByEmail: string | null;
        /** Ajans başına azami bekleyen davet — davet spam'ine karşı tavan. */
        maxPending: number;
      }): Promise<
        { ok: true; invite: InviteView; token: string } | { ok: false; reason: InviteCreateFailure }
      > => {
        const email = normalizeEmail(input.email);

        // Zaten ekipteyse davet anlamsız — ve mail göndermek de gereksiz.
        const member = await db.agencyMember.findFirst({
          where: { agencyId, email },
          select: { id: true },
        });
        if (member) return { ok: false, reason: "already_member" };

        const now = new Date();
        const pending = await db.agencyInvite.findMany({
          where: { agencyId, acceptedAt: null, expiresAt: { gt: now } },
          select: { id: true, email: true },
        });
        // Aynı adrese ikinci kez davet: yeni mail göndermeyi reddediyoruz.
        // Bu hem spam tavanı hem de bir güvenlik tercihi — davet mailini
        // tetikleyen düğme, keyfi bir adrese sınırsız mail atma aracına
        // dönüşmemeli.
        if (pending.some((row) => row.email === email)) {
          return { ok: false, reason: "already_invited" };
        }
        if (pending.length >= input.maxPending) {
          return { ok: false, reason: "invite_quota" };
        }

        const created = await db.agencyInvite.create({
          data: {
            agencyId,
            email,
            role: input.role,
            token: generateInviteToken(),
            expiresAt: inviteExpiry(),
            invitedByEmail: input.invitedByEmail,
          },
        });
        return {
          ok: true,
          invite: {
            id: created.id,
            email: created.email,
            role: created.role,
            expiresAt: created.expiresAt,
            invitedByEmail: created.invitedByEmail,
            createdAt: created.createdAt,
            expired: false,
          },
          token: created.token,
        };
      },

      /**
       * Daveti iptal eder. Kabul EDİLMİŞ davet silinmez (`acceptedAt: null`
       * koşulu): o satır artık bir kayıt, "kim ne zaman katıldı" sorusunun
       * cevabı. Silmek geçmişi yok etmek olurdu.
       */
      cancelById: async (id: string): Promise<boolean> => {
        const result = await db.agencyInvite.deleteMany({
          where: { id, agencyId, acceptedAt: null },
        });
        return result.count === 1;
      },
    },
  };
}
