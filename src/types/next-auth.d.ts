import "next-auth";
import type { AgencyRole } from "@prisma/client";

declare module "next-auth" {
  interface Session {
    /**
     * F6 sonrası da TİPİ DEĞİŞMEDİ ve bu bilinçli: üyelik çözümü auth
     * katmanında bitiyor, aşağı akış (78 çağrı yeri + `getScopedDb`) düz bir
     * `agencyId` görmeye devam ediyor.
     *
     * Not: ekipten çıkarılmış birinin token'ı tazelendiğinde bu alan ÇALIŞMA
     * ZAMANINDA undefined olur (bkz. auth.ts). Tip yine de zorunlu bırakıldı;
     * opsiyonele çevirmek `getScopedDb(session)`e giden her çağrıyı tip
     * hatasına düşürürdü, oysa hepsi zaten `if (!session?.agencyId)` ile
     * korunuyor.
     */
    agencyId: string;
    agencyName?: string | null;
    /** F6 — `owner` davet edebilir/üye çıkarabilir, `member` edemez. */
    agencyRole?: AgencyRole;
    /**
     * Üyeliğin unique anahtarı (`test:` önekli olabilir). Yalnızca davet
     * devrinin ihtiyacı var: orada kullanıcı henüz hedef ajansın üyesi
     * değil, yani `agencyId` üzerinden bulunamaz.
     */
    googleId?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    agencyId?: string;
    agencyName?: string | null;
    /** F6 — üyelik tazelemesinin sorgu anahtarı; `test:` önekli olabilir. */
    googleId?: string;
    agencyRole?: AgencyRole;
    /** F6 — son üyelik doğrulamasının zamanı (ms). Bkz. MEMBERSHIP_REVALIDATE_MS. */
    membershipCheckedAt?: number;
  }
}
