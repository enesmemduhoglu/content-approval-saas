import type { Prisma, PublishSettings } from "@prisma/client";
import { db } from "@/lib/db";
import type { ClientSession } from "@/lib/client-auth";
import { videoKey } from "@/lib/storage-r2";
import { planMove, positionAtEnd, type MoveTarget } from "@/lib/portal-order";
import { renumberPositions } from "@/lib/queue";
import type { PublishSettingsInput } from "@/lib/portal-validation";

/**
 * Video kuyruğu (V3) — müşteri portalının veri katmanı. `getScopedDb`'nin
 * müşteri kapsamlı eşi (README §5 "Güvenlik kuralı").
 *
 * Portal route'ları ve sayfaları ham `db.*` ÇAĞIRMAZ; her sorgu buradan geçer
 * ve buradaki her `where` iki filtreyi taşır:
 *   • `clientId` — oturumdan gelir, istekten DEĞİL. A müşterisinin kullanıcısı
 *     B'nin post id'sini bilse bile satır eşleşmez, 404 döner.
 *   • `source: "portal"` — müşterinin portalı yalnızca kendi yüklediği
 *     videoları yönetir. Ajansın aynı müşteri için hazırladığı postlar (onay
 *     linki akışı) bu yüzeyden görünmez ve değiştirilemez; onların yetki
 *     modeli ayrı (token + ajans oturumu).
 *
 * Karar değiştiren her yol koşullu `updateMany` kullanır; `false`/`0` dönüşü
 * route'ta 409'a çevrilir (CLAUDE.md yarış koruması).
 */

export const PORTAL_VIDEO_SELECT = {
  id: true,
  caption: true,
  status: true,
  rejectionReason: true,
  captionStatus: true,
  captionError: true,
  publishStatus: true,
  publishError: true,
  igPermalink: true,
  publishedAt: true,
  slotAt: true,
  queuePosition: true,
  videoKey: true,
  frameKeys: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PostSelect;

export type PortalVideo = Prisma.PostGetPayload<{ select: typeof PORTAL_VIDEO_SELECT }>;

/**
 * Yayınlanmış (ya da zaten canlıda olduğu için atlanmış) video kuyrukta değil,
 * geçmiştedir. Kuyruk, taşıma ve kuyruk-dışı listeleri aynı tanımı kullansın
 * diye tek yerde.
 */
const NOT_DONE = { notIn: ["published" as const, "duplicate" as const] };
/** Müşterinin dokunabileceği yayın durumları — `publishing` kilitliyken hiçbir şey değişmez. */
const EDITABLE_PUBLISH = { in: ["idle" as const, "failed" as const] };

/** Bu süreden eski `captionStatus = pending` takılmış sayılır (bkz. `requestRegenerate`). */
export const STUCK_PENDING_MS = 10 * 60 * 1000;

export type MoveResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "anchor_not_found" | "stale" | "self" };

export function getClientScopedDb(session: ClientSession) {
  const { clientId } = session;
  const scope = { clientId, source: "portal" as const };

  return {
    clientId,

    client: {
      /** Portal başlığı ve bildirim adresi varsayılanı için; sır içeren kolon seçilmez. */
      get: () =>
        db.client.findUnique({
          where: { id: clientId },
          select: { id: true, name: true, email: true },
        }),

      /**
       * V7a — PWA kimliği (manifest, iOS meta). Ayrı metot çünkü her portal
       * sayfasının `<head>`'i bunu istiyor; `get`'in e-posta alanına orada
       * ihtiyaç yok.
       */
      getApp: () =>
        db.client.findUnique({
          where: { id: clientId },
          select: {
            name: true,
            appName: true,
            appShortName: true,
            appThemeColor: true,
            appIconBase: true,
          },
        }),
    },

    posts: {
      findById: (id: string): Promise<PortalVideo | null> =>
        db.post.findFirst({ where: { id, ...scope }, select: PORTAL_VIDEO_SELECT }),

      /** Günlük yükleme tavanı: taslaklar da sayılır — tamamlanmamış yükleme de bir R2 imzası harcadı. */
      countCreatedSince: (since: Date): Promise<number> =>
        db.post.count({ where: { ...scope, createdAt: { gte: since } } }),

      /**
       * Dosya başına bir TASLAK post. `status: draft` bilinçli: yükleme
       * tamamlanana kadar post hiçbir akışa (onay, tick, hatırlatma) görünmez
       * ve "kuyruktan çıkarılmış" videodan ayırt edilebilir (ikisinin de
       * `queuePosition`'ı null). `complete` onu `pending`e çevirir.
       */
      createDrafts: (files: { ext: string }[]): Promise<{ id: string; videoKey: string }[]> =>
        db.$transaction(async (tx) => {
          const client = await tx.client.findUnique({
            where: { id: clientId },
            select: { agencyId: true },
          });
          if (!client) throw new Error("Müşteri bulunamadı");
          const out: { id: string; videoKey: string }[] = [];
          for (const file of files) {
            const post = await tx.post.create({
              data: {
                agencyId: client.agencyId,
                clientId,
                source: "portal",
                status: "draft",
                caption: "",
                captionStatus: "pending",
                queuePosition: null,
              },
              select: { id: true },
            });
            // Anahtar post id'sinden türüyor, yani önce satır doğmalı.
            const key = videoKey(clientId, post.id, file.ext);
            await tx.post.updateMany({ where: { id: post.id, ...scope }, data: { videoKey: key } });
            out.push({ id: post.id, videoKey: key });
          }
          return out;
        }),

      /**
       * V7b — yükleme durumu. `PORTAL_VIDEO_SELECT`e `uploadId` EKLENMEDİ:
       * o seçim istemciye giden yanıtları besliyor, `uploadId` ise hiçbir
       * yanıtta yer almamalı (kolonun yorumu, schema.prisma).
       */
      findUploadState: (
        id: string
      ): Promise<{ id: string; status: string; videoKey: string | null; uploadId: string | null } | null> =>
        db.post.findFirst({
          where: { id, ...scope },
          select: { id: true, status: true, videoKey: true, uploadId: true },
        }),

      /** Taslağa çok parçalı yükleme kimliğini bağlar; yalnızca boş ve `draft` iken. */
      setUploadId: async (id: string, uploadId: string): Promise<boolean> => {
        const result = await db.post.updateMany({
          where: { id, ...scope, status: "draft", uploadId: null },
          data: { uploadId },
        });
        return result.count === 1;
      },

      /**
       * Parçalar birleşti: kimlik artık R2'de yok (`NoSuchUpload`). Temizlenir
       * ki `complete` yeniden denendiğinde tek PUT yolu gibi yalnızca
       * `headObject`'e baksın ve temizlik cron'u ölü bir kimliği iptal etmeye
       * uğraşmasın. Koşul eski kimlik: araya giren başka bir yazımı ezmesin.
       */
      clearUploadId: async (id: string, uploadId: string): Promise<boolean> => {
        const result = await db.post.updateMany({
          where: { id, ...scope, uploadId },
          data: { uploadId: null },
        });
        return result.count === 1;
      },

      /**
       * Yükleme başlatılamadıysa (R2 çok parçalı yüklemeyi açamadı) az önce
       * doğan taslaklar geri alınır — günlük tavanı boşa yemesinler. Yalnızca
       * `draft`: bu yol tamamlanmış bir videoya asla dokunmamalı.
       */
      deleteDrafts: async (ids: string[]): Promise<number> => {
        const result = await db.post.deleteMany({
          where: { id: { in: ids }, ...scope, status: "draft" },
        });
        return result.count;
      },

      /** Kuyruk: sıradaki videolar, yayınlanana kadar (hata alan da başta kalır — README §5). */
      listQueue: (): Promise<PortalVideo[]> =>
        db.post.findMany({
          where: { ...scope, queuePosition: { not: null }, publishStatus: NOT_DONE },
          orderBy: [{ queuePosition: "asc" }, { createdAt: "asc" }],
          select: PORTAL_VIDEO_SELECT,
        }),

      /** Kuyruk dışı: çıkarılan ya da reddedilen, henüz yayınlanmamış videolar. */
      listOutside: (): Promise<PortalVideo[]> =>
        db.post.findMany({
          where: {
            ...scope,
            queuePosition: null,
            status: { not: "draft" },
            publishStatus: NOT_DONE,
          },
          orderBy: { updatedAt: "desc" },
          take: 100,
          select: PORTAL_VIDEO_SELECT,
        }),

      /** Geçmiş: yayınlananlar ve başarısızlar. */
      listHistory: (): Promise<PortalVideo[]> =>
        db.post.findMany({
          where: { ...scope, publishStatus: { in: ["published", "duplicate", "failed"] } },
          orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
          take: 100,
          select: PORTAL_VIDEO_SELECT,
        }),

      /**
       * Yükleme tamamlandı: taslak → kuyruğun sonu. Koşul `status: draft` —
       * aynı video iki kez tamamlanamaz, yani caption işi de iki kez kuyruğa
       * girmez.
       */
      complete: (id: string, frameKeys: string[]): Promise<boolean> =>
        db.$transaction(async (tx) => {
          const agg = await tx.post.aggregate({
            where: { ...scope, queuePosition: { not: null } },
            _max: { queuePosition: true },
          });
          const result = await tx.post.updateMany({
            where: { id, ...scope, status: "draft" },
            data: {
              status: "pending",
              frameKeys,
              queuePosition: positionAtEnd(agg._max.queuePosition),
              captionStatus: "pending",
              captionError: null,
              // Route birleştirmeden sonra zaten temizliyor; burada da
              // sıfırlanıyor ki kuyruktaki bir postta kimlik asla kalmasın.
              uploadId: null,
            },
          });
          return result.count === 1;
        }),

      /**
       * Caption'ı müşteri elle düzenler. Üretim sürerken (`pending`/`generating`)
       * yazmak yasak: üretim bitince düzenleme sessizce ezilirdi. Üretim
       * `failed` ise elle yazılan metin caption'ı hazır sayar — "yeniden üret"
       * dışında ikinci bir çıkış yolu.
       */
      updateCaption: async (id: string, caption: string): Promise<boolean> => {
        const result = await db.post.updateMany({
          where: {
            id,
            ...scope,
            status: { in: ["pending", "approved"] },
            captionStatus: { in: ["ready", "failed"] },
            publishStatus: EDITABLE_PUBLISH,
          },
          data: { caption, captionStatus: "ready", captionError: null },
        });
        return result.count === 1;
      },

      /**
       * Onay / red. Onay YAYIN TETİKLEMEZ: portal postu kuyrukta slotunu
       * bekler (README §8). Onay için caption hazır olmalı — henüz görülmemiş
       * bir metni onaylamak, `requireApproval` güvencesini boşa düşürürdü.
       * Red videoyu kuyruktan da çıkarır: "bunu yayınlama" kararı sırada yer
       * tutmamalı.
       */
      decide: (
        id: string,
        action: "approve" | "reject",
        ip: string,
        reason: string | null
      ): Promise<boolean> =>
        db.$transaction(async (tx) => {
          const result = await tx.post.updateMany({
            where:
              action === "approve"
                ? { id, ...scope, status: "pending", captionStatus: "ready" }
                : { id, ...scope, status: "pending" },
            data:
              action === "approve"
                ? { status: "approved" }
                : { status: "rejected", rejectionReason: reason, queuePosition: null },
          });
          if (result.count !== 1) return false;
          await tx.approvalAudit.create({
            data: { postId: id, action: action === "approve" ? "approved" : "rejected", ip },
          });
          return true;
        }),

      removeFromQueue: async (id: string): Promise<boolean> => {
        const result = await db.post.updateMany({
          where: { id, ...scope, queuePosition: { not: null }, publishStatus: EDITABLE_PUBLISH },
          data: { queuePosition: null },
        });
        return result.count === 1;
      },

      /**
       * "Tekrar dene": hata → idle; video kuyruktaki yerinde bir sonraki slotu
       * bekler. `slotAt` da temizlenir: tick eski sahiplenmeyi zaten bayat
       * sayıyor ama "bu post artık hiçbir slota bağlı değil" niyeti açık dursun.
       */
      retry: async (id: string): Promise<boolean> => {
        const result = await db.post.updateMany({
          where: { id, ...scope, publishStatus: "failed", queuePosition: { not: null } },
          data: { publishStatus: "idle", publishError: null, slotAt: null },
        });
        return result.count === 1;
      },

      /**
       * "Sona at": videoyu kuyruğun sonuna taşır. Hata almış videoda yayın
       * durumu da `idle`'a döner (sırası gelince yeniden denensin); kuyruktan
       * çıkarılmış bir videoyu kuyruğa GERİ almanın yolu da bu. Reddedilen ve
       * yüklemesi bitmemiş video alınmaz.
       */
      moveToEnd: (id: string): Promise<boolean> =>
        db.$transaction(async (tx) => {
          const current = await tx.post.findFirst({
            where: { id, ...scope },
            select: { publishStatus: true },
          });
          const agg = await tx.post.aggregate({
            where: { ...scope, queuePosition: { not: null }, id: { not: id } },
            _max: { queuePosition: true },
          });
          const result = await tx.post.updateMany({
            where: {
              id,
              ...scope,
              status: { in: ["pending", "approved"] },
              publishStatus: EDITABLE_PUBLISH,
            },
            data: {
              queuePosition: positionAtEnd(agg._max.queuePosition),
              publishStatus: "idle",
              publishError: null,
            },
          });
          if (result.count !== 1) return false;
          // `slotAt` YALNIZCA hatalı videoda temizlenir ("tekrar dene" ile aynı
          // niyet). `idle` bir videoda dolu `slotAt`, tick'in onu şu an bir
          // slota sahiplendiği anlamına gelebilir (bkz. queue-db
          // `claimPostForSlot`); onu silmek aynı videonun ikinci bir slota da
          // sahiplenilmesine kapı açardı.
          if (current?.publishStatus === "failed") {
            await tx.post.updateMany({
              where: { id, ...scope, publishStatus: "idle" },
              data: { slotAt: null },
            });
          }
          return true;
        }),

      /** Sürükle-bırak / ok tuşları. Hesap `portal-order.ts`'te (saf, testli). */
      move: (id: string, target: MoveTarget): Promise<MoveResult> =>
        db.$transaction(async (tx) => {
          const queue = await tx.post.findMany({
            where: {
              ...scope,
              queuePosition: { not: null },
              publishStatus: NOT_DONE,
            },
            orderBy: [{ queuePosition: "asc" }, { createdAt: "asc" }],
            select: { id: true, queuePosition: true, publishStatus: true },
          });
          const moving = queue.find((item) => item.id === id);
          // Yayın kilidi alınmış video yerinden oynamaz: tick onu şu an
          // yayınlıyor, sırası artık anlamsız.
          if (!moving || moving.publishStatus === "publishing") {
            return { ok: false, reason: "not_found" } as const;
          }
          const plan = planMove(
            queue.map((item) => ({ id: item.id, queuePosition: item.queuePosition as number })),
            id,
            target
          );
          if (plan.kind === "error") {
            return {
              ok: false,
              reason: plan.reason === "not_in_queue" ? "not_found" : plan.reason,
            } as const;
          }
          if (plan.kind === "single") {
            await tx.post.updateMany({
              where: { id, ...scope, queuePosition: { not: null } },
              data: { queuePosition: plan.position },
            });
          } else {
            // Float çözünürlüğü tükendi: bütün kuyruk eşit aralıkla yeniden
            // numaralanır (adım `queue.ts`te). Her satır yine kapsam
            // filtresiyle — id listesi DB'den gelse bile.
            for (const row of renumberPositions(plan.order)) {
              await tx.post.updateMany({
                where: { id: row.id, ...scope, queuePosition: { not: null } },
                data: { queuePosition: row.queuePosition },
              });
            }
          }
          return { ok: true } as const;
        }),

      /**
       * Yeniden üretim isteği. Üretim zaten sürüyorsa ikinci iş kuyruğa
       * atılmaz. Onaylı videoda onay GERİ ALINIR: yeni metni kullanıcı henüz
       * görmedi, eski onayla yayınlanırsa `requireApproval` güvencesi delinir.
       *
       * `pending` de kabul — ama yalnızca TAKILMIŞSA (son değişiklik
       * `STUCK_PENDING_MS`'ten eski): yüklemedeki QStash çağrısı başarısız
       * olduysa post sonsuza kadar `pending` kalırdı ve kullanıcının elinde
       * onu kurtaracak buton olmazdı. Taze `pending`de iş zaten yolda.
       */
      requestRegenerate: async (id: string, now: Date = new Date()): Promise<boolean> => {
        const result = await db.post.updateMany({
          where: {
            id,
            ...scope,
            status: { in: ["pending", "approved"] },
            OR: [
              { captionStatus: { in: ["ready", "failed"] } },
              {
                captionStatus: "pending",
                updatedAt: { lt: new Date(now.getTime() - STUCK_PENDING_MS) },
              },
            ],
            publishStatus: EDITABLE_PUBLISH,
          },
          data: { captionStatus: "pending", captionError: null, status: "pending" },
        });
        return result.count === 1;
      },
    },

    settings: {
      get: (): Promise<PublishSettings | null> =>
        db.publishSettings.findUnique({ where: { clientId } }),

      upsert: (input: PublishSettingsInput): Promise<PublishSettings> =>
        db.publishSettings.upsert({
          where: { clientId },
          create: { clientId, ...input },
          update: input,
        }),
    },
  };
}

export type ClientScopedDb = ReturnType<typeof getClientScopedDb>;
