"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  DAY_PRESETS,
  WEEKDAYS,
  dayCountLabel,
  presetFor,
  scheduleSummary,
  timezoneLabel,
  weekdayDateTime,
} from "@/lib/portal-format";
import { parseSlot, slotInstants } from "@/lib/queue";
import { IconClose } from "@/components/portal/icons";
import { PushToggle } from "@/components/portal/push-toggle";

export type SettingsValue = {
  slots: string[];
  /** ISO hafta günleri (1 = Pazartesi … 7 = Pazar), sıralı. */
  days: number[];
  timezone: string;
  requireApproval: boolean;
  paused: boolean;
  notifyEmail: string | null;
};

const MAX_SLOTS = 6;

/** Özet kutusundaki "sıradaki yayınlar" sayısı. */
const UPCOMING_COUNT = 3;
/** Yalnız bir gün seçiliyken 3 yayın 3 haftaya yayılır; +1 gün DST/bugün payı. */
const UPCOMING_SPAN_MS = 22 * 24 * 60 * 60 * 1000;

/**
 * Saat dilimi seçilmiyor: portalın müşterileri Türkiye'de, seçici yalnızca
 * kafa karıştırıyordu. Kaydedilen her ayar bu dilimle gider; başka bir
 * dilimde kayıtlı eski bir ayar da ilk kayıtta İstanbul'a döner.
 */
const PORTAL_TIMEZONE = "Europe/Istanbul";

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
  const [days, setDays] = useState<number[]>(initial.days);
  const [dayGuard, setDayGuard] = useState(false);
  const timezone = PORTAL_TIMEZONE;
  const [requireApproval, setRequireApproval] = useState(initial.requireApproval);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [paused, setPaused] = useState(initial.paused);
  const [notifyEmail, setNotifyEmail] = useState(initial.notifyEmail ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saved, setSaved] = useState(false);

  // "Şimdi" yalnızca tarayıcıda, montajdan sonra: sunucuda çizilen metinle
  // istemcidekinin bir slot sınırında ayrışıp hidrasyon uyarısı vermesin.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  function setSlot(index: number, value: string) {
    setSlots((prev) => prev.map((s, i) => (i === index ? value : s)));
  }

  /**
   * Gün seçimi. Son gün kaldırılamaz (K28): hiç günü olmayan ayar "hiç yayın
   * yok" demek olurdu, onun yolu "Yayını duraklat". Çip kapanmaz, altta neden
   * kapanmadığı söylenir — sessizce yok saymak "dokunuş algılanmadı" sanılırdı.
   */
  function applyDays(next: number[]) {
    if (next.length === 0) {
      setDayGuard(true);
      return;
    }
    setDayGuard(false);
    setDays([...next].sort((a, b) => a - b));
  }

  // Özet, kaydedilmemiş seçimle canlı: kullanıcı "Kaydet"ten ÖNCE ne
  // seçtiğini somut tarihlerle görsün. Hesap tick'in kullandığı saf
  // `slotInstants` — ekrandaki tarih ile yayının gerçekten yapılacağı gün
  // aynı kuraldan çıkıyor (yerel gün, DST). Kuyruk burada yok: bunlar yayın
  // SAATLERİ; hangi videonun gideceği kuyruk ekranında.
  const validSlots = useMemo(
    () => [...new Set(slots.filter((slot) => parseSlot(slot)))].sort(),
    [slots]
  );
  const upcoming = useMemo(() => {
    if (!now) return [];
    return slotInstants(
      { slots: validSlots, timezone, days },
      { from: new Date(now.getTime() + 1), to: new Date(now.getTime() + UPCOMING_SPAN_MS) }
    ).slice(0, UPCOMING_COUNT);
  }, [now, validSlots, timezone, days]);

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
          days,
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
      if (Array.isArray(data.settings.days)) setDays(data.settings.days);
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
          YAYIN GÜNLERİ VE SAATLERİ
        </h2>
        <div className="p-set-card p-set-card--schedule">
          <div className="p-set-group">
            <div className="p-set-head">
              <span className="p-set-title">Günler</span>
              <span className="p-set-sub">{dayCountLabel(days)}</span>
            </div>
            <div className="p-days" role="group" aria-label="Yayın günleri">
              {WEEKDAYS.map((day) => {
                const picked = days.includes(day.iso);
                return (
                  <button
                    key={day.iso}
                    type="button"
                    className="p-day"
                    aria-pressed={picked}
                    aria-label={day.long}
                    onClick={() =>
                      applyDays(picked ? days.filter((d) => d !== day.iso) : [...days, day.iso])
                    }
                  >
                    {day.short}
                  </button>
                );
              })}
            </div>
            <div className="p-presets">
              {DAY_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="p-preset"
                  aria-pressed={presetFor(days) === preset.label}
                  onClick={() => applyDays([...preset.days])}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {dayGuard && (
              <p className="p-note p-note--warn p-note--sm" role="status">
                En az bir gün seç. Hiç yayın istemiyorsan aşağıdan <strong>Yayını duraklat</strong>.
              </p>
            )}
            {error?.field === "days" && (
              <p className="p-error" role="alert">
                {error.message}
              </p>
            )}
          </div>

          <div className="p-set-divider" aria-hidden="true" />

          <div className="p-set-group">
            <span className="p-set-title">Saatler</span>
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
          </div>

          <div className="p-summary">
            <p className="p-summary-title">
              {validSlots.length > 0 ? scheduleSummary(days, validSlots) : "Saat seçilmedi"}
            </p>
            <p className="p-summary-kicker">SIRADAKİ YAYINLAR</p>
            <ul className="p-summary-list" aria-label="Sıradaki yayınlar">
              {upcoming.map((at) => (
                <li key={at.getTime()}>{weekdayDateTime(at, timezone)}</li>
              ))}
            </ul>
            <p className="p-summary-foot">
              {timezoneLabel(timezone)} ·{" "}
              {paused
                ? "yayın duraklatıldı; devam ettirince bu saatlerde sürer"
                : "onaylı video yoksa slot boş geçer"}
            </p>
          </div>
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

      {error && error.field !== "slots" && error.field !== "days" && (
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
