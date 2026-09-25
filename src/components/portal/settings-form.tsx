"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { timezoneLabel } from "@/lib/portal-format";
import { IconClose } from "@/components/portal/icons";
import { PushToggle } from "@/components/portal/push-toggle";

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

/** Tasarımın anahtarı: gerçek `<button role="switch">`, adı görünür başlıktan. */
function Switch({
  checked,
  labelId,
  descId,
  onChange,
}: {
  checked: boolean;
  labelId: string;
  descId: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={descId}
      className="p-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="p-switch-knob" aria-hidden="true" />
    </button>
  );
}

/**
 * Yayın ayarları. Onayı KAPATMAK geri alınabilir ama etkisi anlık ve görünmez:
 * bir sonraki slotta sıradaki video kimse bakmadan yayınlanır. Bu yüzden
 * anahtarı kapatmak tek başına yetmiyor; ayrı bir "anladım" adımı isteniyor
 * (README §7 "kapatırken uyarı").
 *
 * Görünüm V7 mobil tasarımı (saat çipleri, anahtarlar). Değişiklikler yine tek
 * "Kaydet"le gidiyor: anahtar başına anında kayıt, yarım kalmış bir saat
 * düzenlemesini de sunucuya yollardı.
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
    <form className="p-settings-form" onSubmit={save} noValidate>
      <section className="p-set" aria-labelledby="ayar-saatler">
        <h2 className="p-kicker p-kicker--accent" id="ayar-saatler">
          YAYIN SAATLERİ
        </h2>
        <div className="p-set-card">
          <div className="p-chips">
            {slots.map((slot, index) => (
              <span key={index} className="p-chip">
                {/* Görünen saat bizim "HH:MM" değerimiz; gerçek `<input type="time">`
                    onun üstüne serili ve görünmez. Alanın kendi çizimi cihazın
                    yerel ayarına uyuyor: 12 saatlik ayarda dar çipte "19:00"
                    "07:00" (PM kesilmiş) görünüyordu. Dokununca iOS'un tekerlek
                    seçicisi yine açılır. */}
                <span className="p-chip-time" aria-hidden="true">
                  {slot || "--:--"}
                </span>
                <input
                  type="time"
                  aria-label={`${index + 1}. yayın saati`}
                  value={slot}
                  required
                  onChange={(e) => setSlot(index, e.target.value)}
                />
                <button
                  type="button"
                  className="p-chip-x"
                  aria-label={`${slot || "Boş"} saatini kaldır`}
                  disabled={slots.length <= 1}
                  onClick={() => setSlots((prev) => prev.filter((_, i) => i !== index))}
                >
                  <IconClose size={14} strokeWidth={2.4} />
                </button>
              </span>
            ))}
            {slots.length < MAX_SLOTS && (
              <button
                type="button"
                className="p-chip-add"
                onClick={() => setSlots((prev) => [...prev, "12:00"])}
              >
                + Saat ekle
              </button>
            )}
          </div>
          {error?.field === "slots" && (
            <p className="p-error" role="alert">
              {error.message}
            </p>
          )}
          <p className="p-hint p-hint--md">
            Günde {slots.length} video · {timezoneLabel(timezone)}
          </p>
          <label className="p-tz">
            Saat dilimi
            <select className="p-select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="p-set" aria-labelledby="ayar-onay">
        <h2 className="p-kicker p-kicker--accent" id="ayar-onay">
          ONAY VE YAYIN
        </h2>
        <div className="p-set-card p-set-card--rows">
          <div className="p-set-row">
            <div className="p-set-text">
              <span className="p-set-title" id="ayar-onay-baslik">
                Yayından önce onay iste
              </span>
              <span className="p-set-sub" id="ayar-onay-aciklama">
                Kapalıysa sırası gelen video onaysız yayınlanır.
              </span>
            </div>
            <Switch
              checked={requireApproval}
              labelId="ayar-onay-baslik"
              descId="ayar-onay-aciklama"
              onChange={(next) => {
                if (next) {
                  setRequireApproval(true);
                  setConfirmingOff(false);
                } else {
                  // Kapatma hemen uygulanmaz; önce uyarı.
                  setConfirmingOff(true);
                }
              }}
            />
          </div>
          {confirmingOff && requireApproval && (
            <div className="p-set-row p-set-row--stack">
              <div className="p-confirm" role="alertdialog" aria-label="Onayı kapatma uyarısı">
                <p>
                  Onay kapalıyken sırası gelen video <strong>sen bakmadan</strong> Instagram&apos;a
                  yayınlanır — caption&apos;ı hazırsa onay beklenmez. Her yayından sonra e-posta
                  gelir ama yayını geri almak Instagram&apos;dan elle silmeyi gerektirir.
                </p>
                <div className="p-confirm-actions">
                  <button
                    type="button"
                    className="p-btn p-btn--solid-danger"
                    onClick={() => {
                      setRequireApproval(false);
                      setConfirmingOff(false);
                    }}
                  >
                    Anladım, onayı kapat
                  </button>
                  <button
                    type="button"
                    className="p-btn p-btn--outline"
                    onClick={() => setConfirmingOff(false)}
                  >
                    Vazgeç
                  </button>
                </div>
              </div>
            </div>
          )}
          {!requireApproval && (
            <div className="p-set-row p-set-row--stack">
              <p className="p-note p-note--warn">
                Onay kapalı: videolar sırası gelince onay beklemeden yayınlanır.
              </p>
            </div>
          )}
          <div className="p-set-row">
            <div className="p-set-text">
              <span className="p-set-title" id="ayar-durakla-baslik">
                Yayını duraklat
              </span>
              <span className="p-set-sub" id="ayar-durakla-aciklama">
                Açıkken hiçbir video yayınlanmaz, kuyruk bekler.
              </span>
            </div>
            <Switch
              checked={paused}
              labelId="ayar-durakla-baslik"
              descId="ayar-durakla-aciklama"
              onChange={setPaused}
            />
          </div>
        </div>
      </section>

      <section className="p-set" aria-labelledby="ayar-bildirim">
        <h2 className="p-kicker p-kicker--accent" id="ayar-bildirim">
          BİLDİRİMLER
        </h2>
        <div className="p-set-card p-set-card--rows">
          {/* V7c: telefon bildirimi anahtarı kendi satırını ve stilini
              (push-toggle.module.css) getiriyor; sarmalayıcı yalnızca kartın
              yatay payını ve satır ayırıcısını veriyor. Kaydet'ten bağımsız:
              izin isteği bir dokunuşla anında yapılmalı (iOS kuralı). */}
          <div className="p-set-slot">
            <PushToggle />
          </div>
          <div className="p-set-row p-set-row--stack">
            <label htmlFor="ayar-eposta" className="p-set-title">
              Yedek e-posta
            </label>
            <input
              id="ayar-eposta"
              type="email"
              className="p-input p-input--sunk"
              autoComplete="email"
              value={notifyEmail}
              placeholder={defaultNotifyEmail ?? "ornek@alan.com"}
              onChange={(e) => setNotifyEmail(e.target.value)}
            />
            {/* K4: e-posta bildirimlerin YERİNE değil yanında gider; "yedek"
                telefonda bildirim görmeyen için. */}
            <span className="p-set-sub">
              Yayın sonuçları buraya da gider. Boş bırakırsan{" "}
              {defaultNotifyEmail ?? "kayıtlı adresin"} kullanılır.
            </span>
          </div>
        </div>
      </section>

      {error && error.field !== "slots" && (
        <p className="p-note p-note--danger" role="alert">
          {error.message}
        </p>
      )}
      {saved && (
        <p className="p-note p-note--ok" role="status">
          Ayarlar kaydedildi.
        </p>
      )}
      <button
        type="submit"
        className="p-btn p-btn--primary p-btn--block"
        disabled={saving || confirmingOff}
      >
        {saving ? "Kaydediliyor…" : "Kaydet"}
      </button>
    </form>
  );
}
