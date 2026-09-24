import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { portalMutationGuard, portalReadGuard, readJson } from "@/lib/portal-route";
import { validatePublishSettings } from "@/lib/portal-validation";
import { PUBLISH_SETTINGS_DEFAULTS, toSettingsView } from "@/lib/portal-settings";

/**
 * Yayın ayarları (`PublishSettings`, müşteri başına tek satır). Satır yoksa
 * GET şemadaki varsayılanları döner ama YAZMAZ: satırın varlığı "bu müşteri
 * kuyruk yayınına katıldı" demek — tick yalnızca ayarı olan müşterileri tarar.
 * Kullanıcı ayarları ilk kez kaydettiğinde satır doğar.
 */
export async function GET(request: Request) {
  const guard = await portalReadGuard(request);
  if (!guard.ok) return guard.response;
  const scoped = getClientScopedDb(guard.session);
  const [settings, client] = await Promise.all([scoped.settings.get(), scoped.client.get()]);
  return NextResponse.json({
    settings: settings ? toSettingsView(settings) : PUBLISH_SETTINGS_DEFAULTS,
    saved: Boolean(settings),
    // Bildirim adresi boşsa nereye gideceğini arayüz söyleyebilsin.
    defaultNotifyEmail: client?.email ?? null,
  });
}

export async function PUT(request: Request) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "settings" });
  if (!guard.ok) return guard.response;

  const parsed = validatePublishSettings(await readJson(request));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  }
  const settings = await getClientScopedDb(guard.session).settings.upsert(parsed.value);
  return NextResponse.json({ settings: toSettingsView(settings) });
}
