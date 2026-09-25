import { NextResponse } from "next/server";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { portalMutationGuard, portalReadGuard, readJson } from "@/lib/portal-route";
import { isAllowedPushEndpoint, validatePushSubscription } from "@/lib/portal-validation";
import { getVapidPublicKey } from "@/lib/push";
import { PUSH_ENDPOINT_HEADER } from "@/lib/push-shared";

/**
 * V7c — telefon bildirimi aboneliği (V7-pwa §6.1). Abonelik KULLANICIYA
 * bağlı, müşteriye değil: aynı müşterinin iki kişisi ayrı ayrı açıp kapatır.
 *
 *  GET    → { publicKey, subscribed }: VAPID public anahtarı (istemcinin
 *           `applicationServerKey`'i) + bu cihaz bu kullanıcıya kayıtlı mı.
 *  POST   → abone ol (`PushSubscription.toJSON()` gövdesi), upsert by endpoint.
 *  DELETE → { endpoint }: yalnızca KENDİ aboneliği; başkasınınki 404.
 *
 * Kapı sırası `portalMutationGuard`'da: oturum → checkOrigin → hız sınırı;
 * sonra VAPID yapılandırması, sonra gövde doğrulaması, sonra kapsamlı sorgu.
 *
 * Endpoint GET'te sorgu dizgisiyle DEĞİL başlıkla geliyor: endpoint push
 * servisindeki bir yetenek adresi ve sorgu dizgileri erişim loglarına yazılır.
 */

/** Hız sınırı: abonelik günde birkaç kez değişir; dakikada 10 bol. */
const PUSH_RATE_LIMIT_MAX = 10;
/** Kullanıcı başına cihaz tavanı (bkz. `client-scoped-db > push.subscribe`). */
const MAX_SUBSCRIPTIONS_PER_USER = 10;

export async function GET(request: Request) {
  const guard = await portalReadGuard(request);
  if (!guard.ok) return guard.response;

  const endpoint = request.headers.get(PUSH_ENDPOINT_HEADER);
  const subscribed =
    endpoint && isAllowedPushEndpoint(endpoint)
      ? await getClientScopedDb(guard.session).push.isSubscribed(endpoint)
      : false;
  return NextResponse.json({ publicKey: getVapidPublicKey(), subscribed });
}

export async function POST(request: Request) {
  const guard = await portalMutationGuard(request, { action: "push", max: PUSH_RATE_LIMIT_MAX });
  if (!guard.ok) return guard.response;

  // Anahtar yoksa abonelik kaydetmek anlamsız: hiçbir şey gönderilemez ve
  // kullanıcı "açık" görünen bir anahtarla bildirim bekler.
  if (!getVapidPublicKey()) {
    return NextResponse.json({ error: "Bildirimler şu an kullanılamıyor" }, { status: 503 });
  }

  const parsed = validatePushSubscription(await readJson(request));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  }

  const userAgent = request.headers.get("user-agent")?.slice(0, 300) || null;
  await getClientScopedDb(guard.session).push.subscribe(
    { ...parsed.value, userAgent },
    MAX_SUBSCRIPTIONS_PER_USER
  );
  return NextResponse.json({ ok: true, subscribed: true });
}

export async function DELETE(request: Request) {
  const guard = await portalMutationGuard(request, { action: "push", max: PUSH_RATE_LIMIT_MAX });
  if (!guard.ok) return guard.response;

  const body = (await readJson(request)) as { endpoint?: unknown } | undefined;
  const endpoint = body?.endpoint;
  if (typeof endpoint !== "string" || !isAllowedPushEndpoint(endpoint)) {
    return NextResponse.json({ error: "Geçersiz bildirim adresi", field: "endpoint" }, { status: 400 });
  }

  const removed = await getClientScopedDb(guard.session).push.unsubscribe(endpoint);
  if (!removed) {
    return NextResponse.json({ error: "Abonelik bulunamadı" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, subscribed: false });
}
