import { randomUUID } from "node:crypto";

export const APPROVAL_LINK_TTL_DAYS = 7;

export function generateApprovalToken(): string {
  return randomUUID().replace(/-/g, "");
}

export function approvalLinkExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + APPROVAL_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
