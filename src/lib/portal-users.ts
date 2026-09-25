import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeEmail } from "@/lib/membership";
import type { ScopedSession } from "@/lib/scoped-db";

/**
 * Video kuyruğu (V3) — ajansın müşteriye portal erişimi açıp kapattığı katman.
 *
 * `scoped-db.ts`'e eklenmedi (o dosya V3'ün sahipliğinde değil); yerine aynı
 * kural burada uygulanıyor: her sorgu `client: { agencyId }` filtresini
 * taşıyor. Route ayrıca müşteriyi `getScopedDb(session).clients.findById` ile
 * doğruluyor — iki katman, biri unutulsa diğeri tutar.
 */

export type PortalUserView = {
  id: string;
  email: string;
  lastLoginAt: Date | null;
  createdAt: Date;
};

const VIEW_SELECT = { id: true, email: true, lastLoginAt: true, createdAt: true } as const;

export function getAgencyPortalUsers(session: ScopedSession) {
  const { agencyId } = session;
  return {
    list: (clientId: string): Promise<PortalUserView[]> =>
      db.clientUser.findMany({
        where: { clientId, client: { agencyId } },
        orderBy: { createdAt: "asc" },
        select: VIEW_SELECT,
      }),

    /**
     * `ClientUser.email` GLOBAL unique (şema gerekçesi: bir e-posta tek müşteriye
     * ait). Çakışma "başka yerde kayıtlı" diye döner; hangi müşteride olduğu
     * söylenmez — başka ajansın müşteri listesine pencere açmasın.
     */
    create: async (
      clientId: string,
      email: string
    ): Promise<
      | { ok: true; user: PortalUserView & { client: { name: string } } }
      | { ok: false; reason: "client_not_found" | "email_taken" }
    > => {
      const client = await db.client.findFirst({
        where: { id: clientId, agencyId },
        select: { id: true },
      });
      if (!client) return { ok: false, reason: "client_not_found" };
      try {
        const user = await db.clientUser.create({
          data: { clientId, email: normalizeEmail(email) },
          select: { ...VIEW_SELECT, client: { select: { name: true } } },
        });
        return { ok: true, user };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return { ok: false, reason: "email_taken" };
        }
        throw error;
      }
    },

    /**
     * Erişimi kaldırır. Giriş token'ları ve bildirim abonelikleri de silinir
     * (FK RESTRICT); açık portal oturumları bir sonraki istekte ölür çünkü
     * `getClientSession` kullanıcı satırını her istekte doğruluyor. Abonelik
     * ayrıca silinmeseydi erişimi kaldırılan kişinin telefonuna bildirim
     * gitmeye devam ederdi.
     */
    remove: (clientId: string, userId: string): Promise<boolean> =>
      db.$transaction(async (tx) => {
        const owned = { id: userId, clientId, client: { agencyId } };
        const count = await tx.clientUser.count({ where: owned });
        if (count !== 1) return false;
        await tx.clientLoginToken.deleteMany({ where: { clientUser: owned } });
        await tx.pushSubscription.deleteMany({ where: { clientUser: owned } });
        const result = await tx.clientUser.deleteMany({ where: owned });
        return result.count === 1;
      }),
  };
}
