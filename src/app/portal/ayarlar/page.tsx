import { Suspense } from "react";
import type { ClientSession } from "@/lib/client-auth";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { requirePortalSession } from "@/lib/portal-page";
import { PUBLISH_SETTINGS_DEFAULTS, toSettingsView } from "@/lib/portal-settings";
import { r2Configured } from "@/lib/storage-r2";
import { storageView } from "@/lib/storage-usage";
import { PortalShell } from "@/components/portal/portal-shell";
import { SettingsForm } from "@/components/portal/settings-form";
import { StorageCard } from "@/components/portal/storage-card";
import { LogoutButton } from "@/components/portal/logout-button";

export const dynamic = "force-dynamic";

/** R2 listesi ayrı bekler: ayar formu onu beklemeden çizilir. */
async function StorageUsage({ session }: { session: ClientSession }) {
  try {
    const usage = await getClientScopedDb(session).storage.usage();
    return <StorageCard state={{ kind: "ready", view: storageView(usage) }} />;
  } catch (error) {
    console.error("[portal:ayarlar] depolama okunamadı:", (error as Error).message);
    return <StorageCard state={{ kind: "failed" }} />;
  }
}

export default async function PortalSettingsPage() {
  const session = await requirePortalSession();
  const scoped = getClientScopedDb(session);
  const [client, settings] = await Promise.all([scoped.client.get(), scoped.settings.get()]);

  return (
    <PortalShell title="Ayarlar" className="p-page--settings">
      {!settings && (
        <p className="p-note p-note--warn">
          Ayarlar henüz kaydedilmedi. Kaydettiğin anda kuyruk yayına başlar.
        </p>
      )}
      <SettingsForm
        initial={settings ? toSettingsView(settings) : PUBLISH_SETTINGS_DEFAULTS}
        defaultNotifyEmail={client?.email ?? null}
      />
      {r2Configured() && (
        <Suspense fallback={<StorageCard state={{ kind: "loading" }} />}>
          <StorageUsage session={session} />
        </Suspense>
      )}
      <LogoutButton />
    </PortalShell>
  );
}
