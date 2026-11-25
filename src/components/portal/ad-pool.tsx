"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AdCard } from "@/lib/portal-ads";
import { adPublishErrorTitle } from "@/lib/portal-publish-error";
import { CAPTION_MAX_LENGTH } from "@/lib/validation";
import { IconExternal, IconTrash } from "@/components/portal/icons";
import { moveBody } from "@/components/portal/queue-board";
import { Sheet } from "@/components/portal/sheet";

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
    // Çerçeve, kapatma yolları (arka plan, aşağı kaydırma, kapat düğmesi,
    // Escape) ve arka sayfa kilidi `Sheet`te.
    <Sheet
      titleId="p-adsheet-title"
      title={confirmDelete ? "Reklam silinsin mi?" : (card.sourceName ?? "Reklam görseli")}
      busy={busy}
      onClose={onClose}
    >
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
                  // Geri alınamayan işlemin girişi kırmızı (onaydaki düğme dolu kırmızı).
                  className="p-btn p-btn--danger"
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
    </Sheet>
  );
}

/**
 * Sıradaki rozeti YEREL sıradan: sürükleme bırakılır bırakılmaz (sunucu
 * yanıtı beklenmeden) "hangisi çıkacak" doğru görünsün. Kural tick'in
 * `pickNextAd`iyle aynı: sıradaki ilk yayına uygun (sırada ya da sıradaki)
 * reklam. Hata alan ve yayınlanmakta olan durumunu korur.
 */
export function withLocalNext<T extends { state: AdCard["state"] }>(ordered: T[]): T[] {
  let found = false;
  return ordered.map((card) => {
    if (card.state !== "next" && card.state !== "queued") return card;
    const state: AdCard["state"] = found ? "queued" : "next";
    found = true;
    return card.state === state ? card : { ...card, state };
  });
}

/** Sürükleme bırakıldıktan sonraki tıklamanın yutulacağı süre (ms). */
const CLICK_AFTER_DRAG_MS = 400;

function SortableTile({
  card,
  index,
  disabled,
  onOpen,
}: {
  card: CardView;
  index: number;
  disabled: boolean;
  onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    // Instagram'a gitmekte olan reklamın sırası artık anlamsız (sunucu da reddeder).
    disabled: disabled || card.state === "publishing",
  });
  const badge = BADGE[card.state];
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "p-adcell--dragging" : undefined}
    >
      {/* Kartın tamamı tutamaç: basılı tutunca (300 ms) sürükleme başlar,
          kısa dokunuş sayfayı açar. Tutamaç ayrı bir düğme olsaydı 3 sütunlu
          küçük karede parmak hedefi kalmazdı. */}
      <button
        type="button"
        className={`p-adtile${card.state === "failed" ? " p-adtile--failed" : ""}`}
        aria-label={`${index + 1}. reklam${badge ? ` · ${badge.text}` : ""}${
          card.sourceName ? ` · ${card.sourceName}` : ""
        }`}
        onClick={() => onOpen(card.id)}
        {...attributes}
        {...listeners}
      >
        {card.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.coverUrl} alt="" loading="lazy" draggable={false} />
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
}

/**
 * V12b — reklam havuzu (K36): yayın sırasıyla küçük resimler, sıradaki ve
 * hata rozetleri; yayınlananlar ayrı, Instagram linkiyle. Bir karta dokunmak
 * o reklamın sayfasını açar.
 *
 * V12c — basılı tutup sürükleyerek sıralama. Video kuyruğunun deseni
 * (`queue-board.tsx`): iyimser sıra, `moveBody` ile komşular, hata olursa
 * sıra geri alınır; 409'da (başka yerde değişmiş) sayfa yenilenir.
 * Dokunmatikte `TouchSensor` gecikmeli: kısa kaydırma sayfayı kaydırır,
 * yalnızca basılı tutmak kartı kaldırır.
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
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [order, setOrder] = useState(() => pool.map((card) => card.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastDragEnd = useRef(0);

  const byId = new Map(pool.map((card) => [card.id, card]));
  // Sunucudan yeni kart gelirse (yükleme, refresh) yerel sıraya eklenir, silinen düşer.
  const known = order.filter((id) => byId.has(id));
  const fresh = pool.map((card) => card.id).filter((id) => !known.includes(id));
  const ids = [...known, ...fresh];
  const ordered = withLocalNext(ids.map((id) => byId.get(id)!));
  const open = [...ordered, ...published].find((card) => card.id === openId) ?? null;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
    // Klavyede Enter sayfayı açar (kartın asıl işi), Boşluk sürüklemeyi
    // başlatır; dnd-kit varsayılanı ikisini de sürüklemeye ayırıyordu.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    })
  );

  async function commit(next: string[], movedId: string) {
    const previous = ids;
    setOrder(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/ads/${movedId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(moveBody(next, next.indexOf(movedId))),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setOrder(previous);
        setError(data.error ?? "Sıra değiştirilemedi, tekrar dene");
        if (res.status === 409) router.refresh();
        return;
      }
      // "Sıradaki reklam" tahmini sunucuda; yeni sırayla yeniden çizilsin.
      router.refresh();
    } catch {
      setOrder(previous);
      setError("Bağlantı hatası, sıra değiştirilemedi");
    } finally {
      setBusy(false);
    }
  }

  function onDragEnd(event: DragEndEvent) {
    lastDragEnd.current = Date.now();
    const { active, over } = event;
    if (!over || active.id === over.id || busy) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    void commit(arrayMove(ids, from, to), String(active.id));
  }

  function openTile(id: string) {
    // Bırakmanın ardından gelen tıklama sayfayı açmasın.
    if (Date.now() - lastDragEnd.current < CLICK_AFTER_DRAG_MS) return;
    setOpenId(id);
  }

  return (
    <>
      <section className="p-set" aria-labelledby="reklam-havuz">
        <div className="p-section-head">
          <h2 className="p-h2" id="reklam-havuz">
            {ordered.length > 0 ? `Havuzda ${ordered.length} reklam` : "Reklam havuzu"}
          </h2>
          {ordered.length > 1 && <span className="p-hint">Basılı tut, sürükleyerek sırala</span>}
        </div>
        {error && (
          <p className="p-error" role="alert">
            {error}
          </p>
        )}
        {ordered.length === 0 ? (
          <p className="p-empty">Havuz boş. Görsel yükleyince sırası gelen reklam yayınlanır.</p>
        ) : (
          // Sabit `id`: dnd-kit'in erişilebilirlik kimliği sunucu/tarayıcıda
          // ayrışıp hidrasyon uyarısı vermesin (queue-board ile aynı gerekçe).
          <DndContext
            id="reklam-siralama"
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            onDragCancel={() => {
              lastDragEnd.current = Date.now();
            }}
          >
            <SortableContext items={ids} strategy={rectSortingStrategy}>
              <ul className="p-adgrid" aria-label="Reklam havuzu">
                {ordered.map((card, index) => (
                  <SortableTile key={card.id} card={card} index={index} disabled={busy} onOpen={openTile} />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
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
