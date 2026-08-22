import { randomUUID } from "node:crypto";

export const APPROVAL_LINK_TTL_DAYS = 7;

export function generateApprovalToken(): string {
  return randomUUID().replace(/-/g, "");
}

export function approvalLinkExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + APPROVAL_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** F6 — ekip davetinin geçerlilik süresi. Onay linkiyle aynı: 7 gün. */
export const INVITE_TTL_DAYS = 7;

/**
 * F6 — davet token'ı. Onay token'ıyla AYNI üretim yolu bilinçli: `randomUUID`
 * kriptografik bir CSPRNG'den 122 bit rastgelelik veriyor, tahmin edilemez.
 *
 * Ama davet tarafında tek koruma DEĞİL — kabulün asıl koşulu e-posta
 * eşleşmesi (bkz. membership.ts). Token yalnızca davet linkinin adresi.
 */
export function generateInviteToken(): string {
  return randomUUID().replace(/-/g, "");
}

export function inviteExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
