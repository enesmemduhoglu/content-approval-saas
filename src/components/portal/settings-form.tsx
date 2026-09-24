"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type SettingsValue = {
  slots: string[];
  timezone: string;
  requireApproval: boolean;
  paused: boolean;
  notifyEmail: string | null;
};

const MAX_SLOTS = 6;

/** Sık kullanılanlar; kayıtlı değer listede yoksa o da eklenir (hiçbir ayar sessizce değişmesin). */
const TIMEZONES = [
  "Europe/Istanbul",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "UTC",
];

/**
 * Yayın ayarları. Onayı KAPATMAK geri alınabilir ama etkisi anlık ve görünmez:
 * bir sonraki slotta sıradaki video kimse bakmadan yayınlanır. Bu yüzden
 * kutunun işaretini kaldırmak tek başına yetmiyor; ayrı bir "anladım" adımı
 * isteniyor (README §7 "kapatırken uyarı").
 */
export function SettingsForm({
  initial,
  defaultNotifyEmail,
}: {
  initial: SettingsValue;
  defaultNotifyEmail: string | null;
}) {
  const router = useRouter();
  const [slots, setSlots] = useState<string[]>(initial.slots);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [requireApproval, setRequireApproval] = useState(initial.requireApproval);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [paused, setPaused] = useState(initial.paused);
  const [notifyEmail, setNotifyEmail] = useState(initial.notifyEmail ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const zones = TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES];

  function setSlot(index: number, value: string) {
    setSlots((prev) => prev.map((s, i) => (i === index ? value : s)));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/portal/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slots,
          timezone,
          requireApproval,
          paused,
          notifyEmail: notifyEmail.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError({ message: data.error ?? "Kaydedilemedi", field: data.field });
        return;
      }
      setSlots(data.settings.slots);
      setSaved(true);
      router.refresh();
    } catch {
      setError({ message: "Bağlantı hatası, tekrar dene" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="form card" onSubmit={save} noValidate>
      <fieldset className="portal-fieldset">
        <legend>Yayın saatleri</legend>
        <p className="settings-hint">
          Her saatte kuyruktaki sıradaki uygun video yayınlanır. Günlük yayın sayısı = saat sayısı.
        </p>
        {slots.map((slot, index) => (
          <div key={index} className="slot-row">
            <input
              type="time"
              aria-label={`${index + 1}. yayın saati`}
              value={slot}
              required
              onChange={(e) => setSlot(index, e.target.value)}
            />
            <button
              type="button"
              className="button-secondary"
              disabled={slots.length <= 1}
              onClick={() => setSlots((prev) => prev.filter((_, i) => i !== index))}
            >
              Kaldır
            </button>
          </div>
        ))}
        {slots.length < MAX_SLOTS && (
          <button
            type="button"
            className="button-secondary"
            onClick={() => setSlots((prev) => [...prev, "12:00"])}
          >
            Saat ekle
          </button>
        )}
        {error?.field === "slots" && <p className="field-error">{error.message}</p>}
      </fieldset>

      <label>
        Saat dilimi
        <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>

      <label className="portal-check">
        <input
          type="checkbox"
          checked={requireApproval}
          onChange={(e) => {
            if (e.target.checked) {
              setRequireApproval(true);
              setConfirmingOff(false);
            } else {
              // Kapatma hemen uygulanmaz; önce uyarı.
              setConfirmingOff(true);
            }
          }}
        />
        Yayından önce onayım gereksin
      </label>
      {confirmingOff && requireApproval && (
        <div className="portal-confirm" role="alertdialog" aria-label="Onayı kapatma uyarısı">
          <p>
            Onay kapalıyken sırası gelen video <strong>sen bakmadan</strong> Instagram&apos;a
            yayınlanır — caption&apos;ı hazırsa onay beklenmez. Her yayından sonra e-posta
            gelir ama yayını geri almak Instagram&apos;dan elle silmeyi gerektirir.
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="button-reject"
              onClick={() => {
                setRequireApproval(false);
                setConfirmingOff(false);
              }}
            >
              Anladım, onayı kapat
            </button>
            <button type="button" className="button-secondary" onClick={() => setConfirmingOff(false)}>
              Vazgeç
            </button>
          </div>
        </div>
      )}
      {!requireApproval && (
        <p className="token-alert token-alert-soon">
          Onay kapalı: videolar sırası gelince onay beklemeden yayınlanır.
        </p>
      )}

      <label className="portal-check">
        <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
        Yayınları duraklat
      </label>

      <label>
        Bildirim e-postası
        <input
          type="email"
          value={notifyEmail}
          placeholder={defaultNotifyEmail ?? "ornek@alan.com"}
          onChange={(e) => setNotifyEmail(e.target.value)}
        />
        <span className="settings-hint">
          Boş bırakırsan yayın sonuçları {defaultNotifyEmail ?? "kayıtlı adresine"} gider.
        </span>
      </label>
      {error && error.field !== "slots" && <p className="field-error">{error.message}</p>}
      {saved && (
        <p className="notice" role="status">
          Ayarlar kaydedildi.
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={saving || confirmingOff}>
          {saving ? "Kaydediliyor…" : "Kaydet"}
        </button>
      </div>
    </form>
  );
}
