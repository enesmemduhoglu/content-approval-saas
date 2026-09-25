import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Video kuyruğu (V4) test yardımcıları. `db.ts`ten ayrı dosya: portal ve
 * caption fazları paralel ilerliyor, ortak yardımcı dosyasında çakışma olmasın.
 */

/** "HH:MM" — `at` anının İstanbul yerel saati. Slotu gerçek saate göre kurmak için. */
export function istanbulHHMM(at: Date): string {
  return at.toLocaleTimeString("en-GB", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** Şimdiden `minutes` dakika önceki anın dakikaya yuvarlanmış hâli ve slot dizgisi. */
export function slotMinutesAgo(minutes: number): { slot: string; slotAt: Date } {
  const at = new Date(Date.now() - minutes * 60_000);
  at.setUTCSeconds(0, 0);
  return { slot: istanbulHHMM(at), slotAt: at };
}

export function createPublishSettings(
  clientId: string,
  overrides: {
    slots?: string[];
    days?: number[];
    requireApproval?: boolean;
    paused?: boolean;
    notifyEmail?: string | null;
    timezone?: string;
  } = {}
) {
  return db.publishSettings.create({
    data: {
      clientId,
      slots: overrides.slots ?? ["19:00"],
      // Verilmezse şema varsayılanı (tüm günler) — V8 öncesi testler aynen kalsın.
      ...(overrides.days ? { days: overrides.days } : {}),
      timezone: overrides.timezone ?? "Europe/Istanbul",
      requireApproval: overrides.requireApproval ?? true,
      paused: overrides.paused ?? false,
      notifyEmail: overrides.notifyEmail ?? null,
      // Geçmişte: `dueSlots` ayarın kurulduğu andan önceki slotları üretmiyor.
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
}

let counter = 0;

/** Portaldan yüklenmiş, kuyruktaki bir video postu. */
export async function createQueuePost(
  agencyId: string,
  clientId: string,
  overrides: {
    status?: PostStatus;
    queuePosition?: number | null;
    captionStatus?: CaptionStatus;
    publishStatus?: PublishStatus;
    caption?: string;
    frameKeys?: string[];
    igContainerId?: string | null;
    containerAt?: Date | null;
  } = {}
) {
  counter += 1;
  return db.post.create({
    data: {
      agencyId,
      clientId,
      source: "portal",
      caption: overrides.caption ?? `Kuyruk videosu ${counter}\n#ingilizce`,
      status: overrides.status ?? "approved",
      queuePosition: overrides.queuePosition === undefined ? counter * 1024 : overrides.queuePosition,
      captionStatus: overrides.captionStatus ?? "ready",
      publishStatus: overrides.publishStatus ?? "idle",
      videoKey: `clients/${clientId}/videos/v${counter}.mp4`,
      frameKeys: overrides.frameKeys ?? [`clients/${clientId}/frames/v${counter}/0.jpg`],
      igContainerId: overrides.igContainerId ?? null,
      containerAt: overrides.containerAt ?? null,
    },
  });
}
