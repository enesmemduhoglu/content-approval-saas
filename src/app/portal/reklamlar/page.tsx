import Link from "next/link";
import { getClientScopedDb } from "@/lib/client-scoped-db";
import { requirePortalSession } from "@/lib/portal-page";
import { adProjectionText, nextAdProjection, toAdCards, toAdSettingsView } from "@/lib/portal-ads";
import { shortDateTime } from "@/lib/portal-format";
import { isInstagramBlocked } from "@/lib/portal-instagram";
import { PortalShell } from "@/components/portal/portal-shell";
import { AdSettingsForm } from "@/components/portal/ad-settings-form";
import { AdUploader } from "@/components/portal/ad-uploader";
import { AdPool } from "@/components/portal/ad-pool";
import { IconAlert } from "@/components/portal/icons";

export const dynamic = "force-dynamic";

/**
 * V12b — Reklamlar (K36): tek sayfalık reklam görselleri, videoların arasına
 * ek paylaşım. Üstte "sıradaki reklam ne zaman" (tick'in kuralıyla), sonra
 * ayarlar, yükleme ve havuz. Bilerek tek sayfa: üç parça birbirine bağlı
 * (havuz boşsa ayar boşa, ayar kapalıysa havuz bekler) ve hepsi kısa.
 */
export default async function PortalAdsPage() {
  const session = await requirePortalSession();
  const scoped = getClientScopedDb(session);
  const now = new Date();
  const [settings, rows, queue, instagram] = await Promise.all([
    scoped.settings.get(),
    scoped.ads.list(),
    scoped.posts.listQueue(),
    scoped.client.instagramHealth(now),
  ]);
  const timezone = settings?.timezone ?? "Europe/Istanbul";
  const view = toAdSettingsView(settings);
  const { pool, published } = await toAdCards(rows, session.clientId);
  const ready = pool.filter((card) => card.state === "next" || card.state === "queued").length;
  const projection = await nextAdProjection({
    scoped,
    settings,
    queue,
    poolSize: ready,
    instagramBlocked: isInstagramBlocked(instagram),
    now,
  });

  const label = (at: Date | null) => (at ? shortDateTime(at, timezone) : null);
  const cards = (list: typeof pool) =>
    list.map(({ publishedAt, ...card }) => ({ ...card, publishedLabel: label(publishedAt) }));

  // Üst bant: kullanıcının ilk sorusu "reklam çıkacak mı, ne zaman".
  let status: { title: string; sub: string; warn?: boolean };
  if (!settings) {
    status = { title: "Yayın saatleri yok", sub: "Önce Ayarlar'dan yayın günlerini ve saatlerini kaydet.", warn: true };
  } else if (!view.adsEnabled) {
    status = { title: "Reklam kapalı", sub: "Aşağıdan açınca videoların arasına ek paylaşım olarak çıkar." };
  } else if (settings.paused) {
    status = { title: "Duraklatıldı", sub: "Yayın duraklatılmışken reklam da çıkmaz." };
  } else if (ready === 0) {
    status = { title: "Havuz boş", sub: "Görsel yükleyince sırası gelen reklam yayınlanır.", warn: true };
  } else if (!projection) {
    status = { title: "Reklam bekliyor", sub: "Instagram bağlantısı düzelince sırası gelen reklam yayınlanır.", warn: true };
  } else {
    status = {
      title: adProjectionText(projection, timezone, now),
      sub: projection.at
        ? "Sıradaki reklam bu zamanda yayınlanır"
        : "Kuyrukta yeterli video yok; video yükledikçe tarih belli olur",
    };
  }

  return (
    <PortalShell title="Reklamlar" lead="Özel ders reklamların videoların arasına ek paylaşım olarak çıkar.">
      <section className="p-next" aria-label="Sıradaki reklam">
        <span className="p-next-row">
          <span className="p-next-text">
            <span className="p-next-kicker">
              {status.warn && <span className="p-next-dot" aria-hidden="true" />}
              SIRADAKİ REKLAM
            </span>
            <span className="p-next-when p-next-when--sm">{status.title}</span>
            <span className="p-next-sub">{status.sub}</span>
          </span>
        </span>
      </section>
      {!settings && (
        <p className="p-note p-note--warn">
          <IconAlert size={18} />
          <span>
            Reklam, videolarla aynı yayın günlerini kullanır. <Link href="/portal/ayarlar">Ayarlar</Link>
          </span>
        </p>
      )}

      <AdSettingsForm initial={view} videoSlots={settings?.slots ?? []} scheduleSaved={Boolean(settings)} />
      <AdUploader />
      <AdPool pool={cards(pool)} published={cards(published)} defaultCaption={view.adCaption} />
    </PortalShell>
  );
}
