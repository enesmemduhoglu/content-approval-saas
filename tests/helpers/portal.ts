import { randomUUID } from "node:crypto";
import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";
import { db } from "@/lib/db";
import {
  CLIENT_SESSION_COOKIE,
  CLIENT_TRACE_COOKIE,
  signClientSession,
  signPortalTrace,
} from "@/lib/client-auth";

/**
 * Video kuyruğu (V3) — portal testlerinin ortak kurulumları.
 *
 * Oturum, gerçek imzalı çerezle kuruluyor (mock değil): portal route'ları
 * çerezi `Cookie` başlığından okuyup doğruluyor, yani testler imza + "kullanıcı
 * hâlâ var mı" yolunun kendisinden geçiyor.
 */

export function createClientUser(clientId: string, email?: string) {
  return db.clientUser.create({
    data: { clientId, email: email ?? `portal-${randomUUID().slice(0, 8)}@test.local` },
  });
}

export function portalCookie(user: { id: string; clientId: string }): string {
  const { value } = signClientSession({ clientUserId: user.id, clientId: user.clientId });
  return `${CLIENT_SESSION_COOKIE}=${value}`;
}

/** K29 — giriş ekranı iz çerezi (oturum DEĞİL): yalnızca ad/ikon çözer. */
export function portalTraceCookie(clientId: string): string {
  return `${CLIENT_TRACE_COOKIE}=${signPortalTrace(clientId).value}`;
}

/** Yanıttaki `Set-Cookie`'lerden adı verilenin değeri; yazılmadıysa `null`. */
export function setCookieValue(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return null;
}

/** Yanıttaki adı verilen çerezin tam `Set-Cookie` satırı (öznitelikler dahil). */
export function setCookieLine(res: Response, name: string): string | null {
  return res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`)) ?? null;
}

export function portalRequest(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    body?: unknown;
    origin?: string;
    ip?: string;
  } = {}
): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.origin) headers.origin = init.origin;
  if (init.ip) headers["x-forwarded-for"] = init.ip;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

export const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

let positionSeq = 0;

/** Kuyruğa girmiş (yüklemesi tamamlanmış) portal videosu. */
export function createPortalPost(
  agencyId: string,
  clientId: string,
  overrides: {
    status?: PostStatus;
    captionStatus?: CaptionStatus;
    publishStatus?: PublishStatus;
    queuePosition?: number | null;
    caption?: string;
    frameKeys?: string[];
    videoKey?: string | null;
    updatedAt?: Date;
    igPermalink?: string | null;
  } = {}
) {
  positionSeq += 1;
  const id = `p${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  return db.post.create({
    data: {
      id,
      agencyId,
      clientId,
      source: "portal",
      caption: overrides.caption ?? "Hazır caption",
      status: overrides.status ?? "pending",
      captionStatus: overrides.captionStatus ?? "ready",
      publishStatus: overrides.publishStatus ?? "idle",
      queuePosition:
        overrides.queuePosition === undefined ? positionSeq : overrides.queuePosition,
      videoKey:
        overrides.videoKey === undefined ? `clients/${clientId}/videos/${id}.mp4` : overrides.videoKey,
      frameKeys: overrides.frameKeys ?? [`clients/${clientId}/frames/${id}/0.jpg`],
      igPermalink: overrides.igPermalink ?? null,
      ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
    },
  });
}
