import type { PublishSettings } from "@prisma/client";
import type { PublishSettingsInput } from "@/lib/portal-validation";

/**
 * Yayın ayarlarının dışarı çıkan hâli. Route ve ayarlar sayfası aynı şekli
 * kullansın diye tek yerde; `id`/`clientId` gibi iç alanlar yanıta çıkmaz.
 */
export type PublishSettingsView = Omit<PublishSettingsInput, "days"> & {
  /** Girdide isteğe bağlı (eski istemci), dışarı çıkan hâlde her zaman dolu. */
  days: number[];
};

/** Şemadaki `@default`larla aynı — satır yokken gösterilecek değerler. */
export const PUBLISH_SETTINGS_DEFAULTS: PublishSettingsView = {
  slots: ["19:00"],
  days: [1, 2, 3, 4, 5, 6, 7],
  timezone: "Europe/Istanbul",
  requireApproval: true,
  paused: false,
  notifyEmail: null,
};

export function toSettingsView(settings: PublishSettings): PublishSettingsView {
  return {
    slots: settings.slots,
    days: settings.days,
    timezone: settings.timezone,
    requireApproval: settings.requireApproval,
    paused: settings.paused,
    notifyEmail: settings.notifyEmail,
  };
}
