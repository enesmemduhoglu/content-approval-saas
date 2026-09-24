import { getClientScopedDb } from "@/lib/client-scoped-db";
import { requirePortalSession } from "@/lib/portal-page";
import { PUBLISH_SETTINGS_DEFAULTS, toSettingsView } from "@/lib/portal-settings";
import { PortalNav } from "@/components/portal/portal-nav";
import { SettingsForm } from "@/components/portal/settings-form";

export const dynamic = "force-dynamic";

export default async function PortalSettingsPage() {
  const session = await requirePortalSession();
  const scoped = getClientScopedDb(session);
  const [client, settings] = await Promise.all([scoped.client.get(), scoped.settings.get()]);

  return (
    <>
      <PortalNav clientName={client?.name ?? "Portal"} />
      <main className="container portal-main">
        <h1>Ayarlar</h1>
        {!settings && (
          <p className="notice">
            Ayarlar henüz kaydedilmedi. Kaydettiğin anda kuyruk yayına başlar.
          </p>
        )}
        <SettingsForm
          initial={settings ? toSettingsView(settings) : PUBLISH_SETTINGS_DEFAULTS}
          defaultNotifyEmail={client?.email ?? null}
        />
      </main>
    </>
  );
}
