"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AdCard } from "@/lib/portal-ads";
import { adPublishErrorTitle } from "@/lib/portal-publish-error";
import { CAPTION_MAX_LENGTH } from "@/lib/validation";
import { IconExternal, IconTrash } from "@/components/portal/icons";

type CardView = Omit<AdCard, "publishedAt"> & { publishedLabel: string | null };

const BADGE: Partial<Record<AdCard["state"], { text: string; tone: string }>> = {
  next: { text: "Sıradaki", tone: "p-badge--navy" },
  publishing: { text: "Yayınlanıyor", tone: "p-badge--sand" },
  failed: { text: "Hata", tone: "p-badge--red" },
};

async function call(
  url: string,
  init: RequestInit,
  fallback: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, init);
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error ?? fallback };
  } catch {
    return { ok: false, error: "Bağlantı hatası, tekrar dene" };
  }
}

/**
 * Bir reklamın sayfası (alttan açılır): büyük görsel, reklama özel metin,
 * sil ve — hata aldıysa — tekrar dene. Silme ayrı bir onay adımı ister
 * (portalın geri alınamayan işlemleri tek dokunuşla yapılmıyor).
 */
function AdSheet({
  card,
  defaultCaption,
  onClose,
}: {
  card: CardView;
  defaultCaption: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [caption, setCaption] = useState(card.caption);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = card.state === "next" || card.state === "queued" || card.state === "failed";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
    router.refresh();
  }

  const json = (body: unknown): RequestInit => ({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return (
    <div className="p-sheet-layer">
      <div className="p-sheet-backdrop" aria-hidden="true" onClick={busy ? undefined : onClose} />
      <div className="p-sheet" role="dialog" aria-modal="true" aria-labelledby="p-adsheet-title">
        <span className="p-sheet-handle" aria-hidden="true" />
        <h2 className="p-sheet-title" id="p-adsheet-title">
          {confirmDelete ? "Reklam silinsin mi?" : (card.sourceName ?? "Reklam görseli")}
        </h2>
        {card.coverUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.coverUrl} alt="" className="p-adsheet-img" />
        )}

        {confirmDelete ? (
          <>
            <p className="p-sheet-text">
              Görsel ve metni kalıcı olarak silinir. <strong>Bu geri alınamaz.</strong>
            </p>
            {error && (
              <p className="p-error" role="alert">
                {error}
              </p>
            )}
            <div className="p-actionbar-row">
              <button
                type="button"
                className="p-btn p-btn--outline"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
                autoFocus
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="p-btn p-btn--solid-danger p-btn--grow"
                disabled={busy}
                onClick={() =>
                  run(() => call(`/api/portal/ads/${card.id}`, { method: "DELETE" }, "Reklam silinemedi"))
                }
              >
                <IconTrash size={18} />
                {busy ? "Siliniyor…" : "Kalıcı olarak sil"}
              </button>
            </div>
          </>
        ) : (
          <>
            {card.state === "failed" && (
              <p className="p-note p-note--danger" role="status">
                {adPublishErrorTitle(card.publishError)}
              </p>
            )}
            {editable ? (
              <>
                <label htmlFor="p-adsheet-caption" className="p-set-title">
                  Bu reklamın metni
                </label>
                <textarea
                  id="p-adsheet-caption"
                  className="p-textarea"
                  rows={5}
                  maxLength={CAPTION_MAX_LENGTH}
                  value={caption}
                  placeholder={defaultCaption || "Boş bırakırsan varsayılan reklam metni kullanılır"}
                  onChange={(e) => setCaption(e.target.value)}
                />
                <span className="p-set-sub">
                  Boş bırakırsan varsayılan reklam metni kullanılır.
                </span>
              </>
            ) : (
              <p className="p-sheet-text">{card.caption || defaultCaption}</p>
            )}
            {error && (
              <p className="p-error" role="alert">
                {error}
              </p>
            )}
            <div className="p-actionbar-row">
              {editable && (
                <button
                  type="button"
                  className="p-btn p-btn--outline"
                  aria-label="Reklamı sil"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  <IconTrash size={18} />
                </button>
              )}
              {card.state === "failed" && (
                <button
                  type="button"
                  className="p-btn p-btn--outline p-btn--grow"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      call(`/api/portal/ads/${card.id}/retry`, { method: "POST" }, "Tekrar denenemedi")
                    )
                  }
                >
                  Tekrar dene
                </button>
              )}
              {editable ? (
                <button
                  type="button"
                  className="p-btn p-btn--primary p-btn--grow"
                  disabled={busy || caption === card.caption}
                  onClick={() =>
                    run(() =>
                      call(`/api/portal/ads/${card.id}`, json({ caption }), "Metin kaydedilemedi")
                    )
                  }
                >
                  {busy ? "Kaydediliyor…" : "Metni kaydet"}
                </button>
              ) : (
                <button type="button" className="p-btn p-btn--outline p-btn--grow" onClick={onClose}>
                  Kapat
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * V12b — reklam havuzu (K36): yayın sırasıyla küçük resimler, sıradaki ve
 * hata rozetleri; yayınlananlar ayrı, Instagram linkiyle. Bir karta dokunmak
 * o reklamın sayfasını açar.
 */
export function AdPool({
  pool,
  published,
  defaultCaption,
}: {
  pool: CardView[];
  published: CardView[];
  defaultCaption: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = [...pool, ...published].find((card) => card.id === openId) ?? null;

  return (
    <>
      <section className="p-set" aria-labelledby="reklam-havuz">
        <div className="p-section-head">
          <h2 className="p-h2" id="reklam-havuz">
            {pool.length > 0 ? `Havuzda ${pool.length} reklam` : "Reklam havuzu"}
          </h2>
          {pool.length > 1 && <span className="p-hint">Yüklediğin sırayla çıkar</span>}
        </div>
        {pool.length === 0 ? (
          <p className="p-empty">Havuz boş. Görsel yükleyince sırası gelen reklam yayınlanır.</p>
        ) : (
          <ul className="p-adgrid" aria-label="Reklam havuzu">
            {pool.map((card, index) => {
              const badge = BADGE[card.state];
              return (
                <li key={card.id}>
                  <button
                    type="button"
                    className={`p-adtile${card.state === "failed" ? " p-adtile--failed" : ""}`}
                    aria-label={`${index + 1}. reklam${badge ? ` · ${badge.text}` : ""}${
                      card.sourceName ? ` · ${card.sourceName}` : ""
                    }`}
                    onClick={() => setOpenId(card.id)}
                  >
                    {card.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={card.coverUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="p-adtile-empty" aria-hidden="true" />
                    )}
                    <span className="p-adtile-no" aria-hidden="true">
                      {index + 1}
                    </span>
                    {badge && (
                      <span className={`p-badge ${badge.tone} p-adtile-badge`} aria-hidden="true">
                        {badge.text}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {published.length > 0 && (
        <section className="p-set" aria-labelledby="reklam-yayinlanan">
          <h2 className="p-kicker" id="reklam-yayinlanan">
            YAYINLANAN · {published.length}
          </h2>
          <ul className="p-list">
            {published.map((card) => (
              <li key={card.id} className="p-hcard">
                {card.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={card.coverUrl} alt="" className="p-hcover" loading="lazy" />
                ) : (
                  <span className="p-hcover p-cover--empty" aria-hidden="true" />
                )}
                <div className="p-hcard-body">
                  {card.publishedLabel && <span className="p-hcard-date">{card.publishedLabel}</span>}
                  <span className="p-hcard-caption">{card.caption || defaultCaption}</span>
                </div>
                {card.igPermalink && (
                  <a
                    href={card.igPermalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-square-link"
                    aria-label="Instagram'da aç"
                  >
                    <IconExternal size={18} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {open && <AdSheet card={open} defaultCaption={defaultCaption} onClose={() => setOpenId(null)} />}
    </>
  );
}

export type { CardView as AdCardView };
