import { getClientScopedDb } from "@/lib/client-scoped-db";
import { requirePortalSession } from "@/lib/portal-page";
import { getPortalContext } from "@/lib/portal-app";
import { PUBLISH_SETTINGS_DEFAULTS, toSettingsView } from "@/lib/portal-settings";
import { PortalShell } from "@/components/portal/portal-shell";
import { SettingsForm } from "@/components/portal/settings-form";
import { AppCard } from "@/components/portal/app-card";

export const dynamic = "force-dynamic";

export default async function PortalSettingsPage() {
  const session = await requirePortalSession();
  const scoped = getClientScopedDb(session);
  const [client, settings, { app }] = await Promise.all([
    scoped.client.get(),
    scoped.settings.get(),
    getPortalContext(),
  ]);

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
      <AppCard appName={app.name} iconSrc={`${app.iconBase}/icon-192.png`} />
    </PortalShell>
  );
}
