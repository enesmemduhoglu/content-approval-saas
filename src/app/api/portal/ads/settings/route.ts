import { NextResponse } from "next/server";
import { counterOnSave } from "@/lib/ads";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { portalMutationGuard, readJson } from "@/lib/portal-route";
import { validateAdSettings } from "@/lib/portal-validation";
import { syncQueueWakes } from "@/lib/queue-wake";

/**
 * V12 — reklam ayarları (aç/kapa, "her N–M videoda bir", reklam saati,
 * varsayılan metin). Video ayarlarından (`api/portal/settings`) ayrı uç:
 * önbellekteki eski PWA'nın Ayarlar formu reklam alanlarını bilmiyor, ortak
 * bir PUT onları sessizce ezerdi.
 *
 * Sayaç (`adCountFrom`, `adNextAfter`) istemciden ALINMAZ: `counterOnSave`
 * mevcut satırla yeni alanlardan hesaplar.
 */
export async function PUT(request: Request) {
  // Kapı sırası: oturum → checkOrigin → hız sınırı (bkz. portal-route.ts).
  const guard = await portalMutationGuard(request, { action: "ad-settings" });
  if (!guard.ok) return guard.response;

  const body = await readJson(request);
  const scoped = getClientScopedDb(guard.session);
  const current = await scoped.settings.get();
  // Reklam video takvimine bağlı (aynı günler, sayaç video yayınını sayıyor):
  // yayın saatleri hiç kaydedilmemiş müşteride reklamın çıkacağı takvim yok.
  if (!current) {
    return NextResponse.json(
      { error: "Önce Ayarlar'dan yayın günlerini ve saatlerini kaydet", field: "adsEnabled" },
      { status: 409 }
    );
  }

  const parsed = validateAdSettings(body, current.slots);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  }

  const counter = counterOnSave(current, parsed.value, new Date());
  if (!(await scoped.settings.updateAds({ ...parsed.value, ...counter }))) {
    return NextResponse.json({ error: "Ayarlar kaydedilemedi, sayfayı yenile" }, { status: 409 });
  }

  // Reklam saati uyandırması açma/kapama ve saat değişikliğiyle değişiyor.
  const wakes = await syncQueueWakes();
  if (wakes.failed > 0 || wakes.skipped) {
    console.error("[portal:ad-settings] uyandırmalar kurulamadı:", wakes);
  }

  return NextResponse.json({
    ads: {
      ...parsed.value,
      adNextAfter: counter.adNextAfter ?? current.adNextAfter,
      adCountFrom: counter.adCountFrom ?? current.adCountFrom,
    },
  });
}
