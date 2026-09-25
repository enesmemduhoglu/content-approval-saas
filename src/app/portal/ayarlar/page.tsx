import { getClientScopedDb } from "@/lib/client-scoped-db";
import { requirePortalSession } from "@/lib/portal-page";
import { PUBLISH_SETTINGS_DEFAULTS, toSettingsView } from "@/lib/portal-settings";
import { PortalShell } from "@/components/portal/portal-shell";
import { SettingsForm } from "@/components/portal/settings-form";
import { LogoutButton } from "@/components/portal/logout-button";

export const dynamic = "force-dynamic";

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
      <LogoutButton />
    </PortalShell>
  );
}
