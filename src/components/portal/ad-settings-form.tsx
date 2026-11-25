"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AD_GAP_MAX, AD_GAP_MIN } from "@/lib/ads";
import type { AdSettingsView } from "@/lib/portal-ads";
import { CAPTION_MAX_LENGTH } from "@/lib/validation";

type Mode = "fixed" | "range";

/** Kayıtlı değerden mod: sabit mod sunucuda min = max olarak duruyor (K36). */
export function modeOf(value: Pick<AdSettingsView, "adMinGap" | "adMaxGap">): Mode {
  return value.adMinGap === value.adMaxGap ? "fixed" : "range";
}

/** Formdan sunucuya: sabit modda tek sayı iki sınıra birden yazılır. */
export function gapsFor(mode: Mode, min: number, max: number): { adMinGap: number; adMaxGap: number } {
  return mode === "fixed" ? { adMinGap: min, adMaxGap: min } : { adMinGap: min, adMaxGap: max };
}

/** "Her 5 videoda bir" / "5–10 videoda bir, rastgele" — kartın canlı özeti. */
export function frequencyLabel(mode: Mode, min: number, max: number): string {
  return mode === "fixed" ? `Her ${min} videoda bir` : `${min}–${max} videoda bir, rastgele`;
}

function toInt(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * V12b — reklam ayarları (K36). Video ayarlarından ayrı form ve ayrı uç
 * (`PUT /api/portal/ads/settings`): eski PWA'nın Ayarlar formu bu alanları
 * bilmiyor, ortak kayıt onları ezerdi. Görünüm Ayarlar'ın kart dili.
 */
export function AdSettingsForm({
  initial,
  videoSlots,
  scheduleSaved,
}: {
  initial: AdSettingsView;
  /** Kayıtlı video saatleri: reklam saati onlardan biri olamaz (sunucu da reddeder). */
  videoSlots: string[];
  /** Yayın ayarı hiç kaydedilmemişse reklam açılamaz (takvim yok). */
  scheduleSaved: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.adsEnabled);
  const [mode, setMode] = useState<Mode>(modeOf(initial));
  const [min, setMin] = useState(String(initial.adMinGap));
  const [max, setMax] = useState(String(initial.adMaxGap));
  const [slot, setSlot] = useState(initial.adSlot);
  const [caption, setCaption] = useState(initial.adCaption);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  const minN = toInt(min);
  const maxN = mode === "fixed" ? minN : toInt(max);

  /** Sunucu kuralının ikizi — kullanıcı "Kaydet"e basmadan hatayı alanın altında görsün. */
  function localError(): { message: string; field: string } | null {
    const inRange = (n: number) => n >= AD_GAP_MIN && n <= AD_GAP_MAX;
    if (!inRange(minN) || !inRange(maxN)) {
      return { field: "adMinGap", message: `Video sayısı ${AD_GAP_MIN} ile ${AD_GAP_MAX} arasında olmalı` };
    }
    if (minN > maxN) return { field: "adMaxGap", message: "Üst sınır alt sınırdan küçük olamaz" };
    if (videoSlots.includes(slot)) {
      return { field: "adSlot", message: "Reklam saati video yayın saatlerinden farklı olmalı" };
    }
    if (enabled && !caption.trim()) return { field: "adCaption", message: "Reklam metni boş olamaz" };
    return null;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaved(false);
    const local = localError();
    if (local) {
      setError(local);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/ads/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adsEnabled: enabled,
          adSlot: slot,
          ...gapsFor(mode, minN, maxN),
          adCaption: caption.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError({ message: data.error ?? "Kaydedilemedi", field: data.field });
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError({ message: "Bağlantı hatası, tekrar dene" });
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (field: string) =>
    error?.field === field ? (
      <p className="p-error" role="alert">
        {error.message}
      </p>
    ) : null;
  const generalError = error && !["adMinGap", "adMaxGap", "adSlot", "adCaption"].includes(error.field ?? "");

  return (
    <form className="p-settings-form" onSubmit={save} noValidate>
      <section className="p-set" aria-labelledby="reklam-ayar">
        <h2 className="p-kicker p-kicker--accent" id="reklam-ayar">
          REKLAM AYARLARI
        </h2>
        <div className="p-set-card p-set-card--rows">
          <div className="p-set-row">
            <div className="p-set-text">
              <span className="p-set-title" id="reklam-acik-baslik">
                Reklamları yayınla
              </span>
              <span className="p-set-sub" id="reklam-acik-aciklama">
                {scheduleSaved
                  ? "Açıkken videoların arasına ek paylaşım olarak çıkar."
                  : "Önce Ayarlar'dan yayın günlerini ve saatlerini kaydet."}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-labelledby="reklam-acik-baslik"
              aria-describedby="reklam-acik-aciklama"
              className="p-switch"
              disabled={!scheduleSaved}
              onClick={() => setEnabled((v) => !v)}
            >
              <span className="p-switch-knob" aria-hidden="true" />
            </button>
          </div>

          <div className="p-set-row p-set-row--stack">
            <span className="p-set-title" id="reklam-siklik">
              Sıklık
            </span>
            <div className="p-seg" role="tablist" aria-labelledby="reklam-siklik">
              <button
                type="button"
                role="tab"
                className="p-seg-tab"
                aria-selected={mode === "fixed"}
                onClick={() => setMode("fixed")}
              >
                Sabit
              </button>
              <button
                type="button"
                role="tab"
                className="p-seg-tab"
                aria-selected={mode === "range"}
                onClick={() => setMode("range")}
              >
                Aralık
              </button>
            </div>
            <div className="p-adgap">
              {mode === "fixed" ? (
                <label className="p-adgap-line">
                  Her
                  <input
                    type="number"
                    inputMode="numeric"
                    className="p-input p-input--sunk p-adgap-input"
                    min={AD_GAP_MIN}
                    max={AD_GAP_MAX}
                    value={min}
                    aria-label="Kaç videoda bir"
                    onChange={(e) => setMin(e.target.value)}
                  />
                  videoda bir
                </label>
              ) : (
                <span className="p-adgap-line">
                  <input
                    type="number"
                    inputMode="numeric"
                    className="p-input p-input--sunk p-adgap-input"
                    min={AD_GAP_MIN}
                    max={AD_GAP_MAX}
                    value={min}
                    aria-label="En az kaç video"
                    onChange={(e) => setMin(e.target.value)}
                  />
                  –
                  <input
                    type="number"
                    inputMode="numeric"
                    className="p-input p-input--sunk p-adgap-input"
                    min={AD_GAP_MIN}
                    max={AD_GAP_MAX}
                    value={max}
                    aria-label="En fazla kaç video"
                    onChange={(e) => setMax(e.target.value)}
                  />
                  videoda bir
                </span>
              )}
            </div>
            <span className="p-set-sub">
              {mode === "fixed"
                ? "Her reklamdan sonra aynı sayıda video yayınlanır."
                : "Her reklamdan sonra bu aralıktan rastgele bir sayı seçilir; profilde daha doğal durur."}
            </span>
            {fieldError("adMinGap")}
            {fieldError("adMaxGap")}
          </div>

          <div className="p-set-row">
            <div className="p-set-text">
              <span className="p-set-title" id="reklam-saat-baslik">
                Reklam saati
              </span>
              <span className="p-set-sub">Videolarla aynı günlerde, videodan ayrı bir saatte.</span>
            </div>
            <span className="p-chip">
              <span className="p-chip-time" aria-hidden="true">
                {slot || "--:--"}
              </span>
              <input
                type="time"
                aria-labelledby="reklam-saat-baslik"
                value={slot}
                required
                onChange={(e) => setSlot(e.target.value)}
              />
            </span>
          </div>
          {fieldError("adSlot")}

          <div className="p-set-row p-set-row--stack">
            <label htmlFor="reklam-metin" className="p-set-title">
              Varsayılan reklam metni
            </label>
            <textarea
              id="reklam-metin"
              className="p-textarea"
              rows={5}
              maxLength={CAPTION_MAX_LENGTH}
              value={caption}
              placeholder="Özel ders için DM'den yaz! İlk ders %50 indirimli. #ingilizce"
              onChange={(e) => setCaption(e.target.value)}
            />
            <span className="p-set-sub">
              Kendi metni olmayan her reklam bununla yayınlanır · {caption.length}/{CAPTION_MAX_LENGTH}
            </span>
            {fieldError("adCaption")}
          </div>
        </div>
        <p className="p-hint">{frequencyLabel(mode, minN, maxN)} · {slot || "--:--"}</p>
      </section>

      {generalError && (
        <p className="p-note p-note--danger" role="alert">
          {error!.message}
        </p>
      )}
      {saved && (
        <p className="p-note p-note--ok" role="status">
          Reklam ayarları kaydedildi.
        </p>
      )}
      <button type="submit" className="p-btn p-btn--primary p-btn--block" disabled={saving}>
        {saving ? "Kaydediliyor…" : "Kaydet"}
      </button>
    </form>
  );
}
