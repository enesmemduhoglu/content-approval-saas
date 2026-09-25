"use client";

import { useEffect, useState } from "react";
import { goToPortalHome } from "@/lib/portal-hard-nav";
import { maskEmail } from "@/lib/portal-format";

/** "Kodu tekrar gönder" bekleme süresi. Sunucu e-posta başına dakikada 3 istek kabul ediyor. */
export const RESEND_COOLDOWN_SECONDS = 60;

export type LoginEmailResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Giriş e-postası isteği (`POST /api/portal/login`) — ilk gönderim ve "Kodu
 * tekrar gönder" aynı yoldan. Yanıt adres kayıtlı olsa da olmasa da aynı
 * (sunucu öyle döner, K19).
 */
export async function requestLoginEmail(email: string): Promise<LoginEmailResult> {
  try {
    const res = await fetch("/api/portal/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? "Bir hata oluştu, tekrar dene" };
    return { ok: true, message: data.message ?? "Bu adres kayıtlıysa bir giriş kodu gelecek." };
  } catch {
    return { ok: false, error: "Bağlantı hatası, tekrar dene" };
  }
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * V7a — e-postadaki 6 haneli kodla giriş (`POST /api/portal/login/code`).
 *
 * iPhone'da ana ekran uygulamasının çerezleri Safari'den ayrı: e-postadaki
 * link Safari'de açılır ve uygulama giriş ekranında kalır. Kod ise uygulamanın
 * içinde yazılır.
 *
 * Görünüm V7 mobil tasarımı: altı kutu. Ama gerçek alan TEK: kutuların üstüne
 * serilmiş görünmez bir `<input>`. Altı ayrı alan iOS'un "Mail'den gelen kodu
 * öner"ini ve yapıştırmayı bozar, ekran okuyucuya da altı etiketsiz alan
 * okuturdu. Alan nitelikleri iOS için önemli:
 *  • `inputMode="numeric"`: sayı klavyesi (type="number" DEĞİL — baştaki
 *    sıfırı yutar, kaydırınca değer değiştirir);
 *  • `autoComplete="one-time-code"`: iOS, Mail'e gelen kodu klavyenin üstünde
 *    önerir; tek dokunuşla dolar.
 */
export function CodeLoginForm({ initialEmail }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // İlk gönderim az önce yapıldıysa sayaç ondan başlar.
  const [cooldown, setCooldown] = useState(initialEmail ? RESEND_COOLDOWN_SECONDS : 0);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState<string | null>(null);

  const digits = code.replace(/\D/g, "").slice(0, 6);
  const ready = digits.length === 6 && email.trim().length > 0;

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/login/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: digits }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Giriş yapılamadı");
        // Yanlış kod alanda kalmasın: bir sonraki deneme temiz başlasın.
        setCode("");
        return;
      }
      // Tam yükleme: layout meta etiketleri (iOS ana ekran adı/ikonu) oturumla
      // yeniden üretilsin — bkz. portal-hard-nav.ts.
      goToPortalHome();
    } catch {
      setError("Bağlantı hatası, tekrar dene");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (resending || cooldown > 0 || !email.trim()) return;
    setResending(true);
    setError(null);
    setResent(null);
    const result = await requestLoginEmail(email);
    setResending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setResent("Yeni kod gönderildi; gelen kutunu (ve spam klasörünü) kontrol et.");
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  const activeIndex = Math.min(digits.length, 5);

  return (
    <form className="p-login-form" onSubmit={submit} aria-label="Kodla giriş">
      {initialEmail ? (
        <p className="p-login-lead">
          E-postana 6 haneli bir kod gönderdik
          <br />
          <strong>{maskEmail(initialEmail)}</strong>
        </p>
      ) : (
        <div className="p-field">
          <label htmlFor="giris-eposta" className="p-label">
            E-posta adresin
          </label>
          <input
            id="giris-eposta"
            type="email"
            className="p-input p-input--lg"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      )}

      <div className="p-login-fields">
        <label htmlFor="giris-kod" className="p-label">
          Giriş kodu
        </label>
        <div className={`p-code${error ? " p-code--error" : ""}`}>
          <input
            id="giris-kod"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            value={digits}
            aria-describedby="giris-kod-ipucu"
            aria-invalid={error ? true : undefined}
            onChange={(e) => setCode(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          {Array.from({ length: 6 }, (_, i) => {
            const char = digits[i];
            const active = focused && i === activeIndex && digits.length < 6;
            return (
              <span
                key={i}
                aria-hidden="true"
                data-testid="kod-kutusu"
                className={`p-code-box${char ? " p-code-box--filled" : ""}${active ? " p-code-box--active" : ""}`}
              >
                {char ?? (active ? <span className="p-code-caret" /> : null)}
              </span>
            );
          })}
        </div>
        <span className="p-hint" id="giris-kod-ipucu">
          Kod 15 dakika geçerli · iPhone kodu e-postadan önerebilir
        </span>
        {error && (
          <p className="p-error" role="alert">
            {error}
          </p>
        )}
        {resent && (
          <p className="p-hint" role="status">
            {resent}
          </p>
        )}
      </div>

      <div className="p-login-foot">
        <button type="submit" className="p-btn p-btn--primary p-btn--lg p-btn--block" disabled={busy || !ready}>
          {busy ? "Giriş yapılıyor…" : "Giriş yap"}
        </button>
        <button
          type="button"
          className="p-textbtn"
          disabled={resending || cooldown > 0 || !email.trim()}
          onClick={resend}
        >
          {resending
            ? "Gönderiliyor…"
            : cooldown > 0
              ? `Kodu tekrar gönder · ${formatCountdown(cooldown)}`
              : "Kodu tekrar gönder"}
        </button>
        <p className="p-safari-note">
          E-postadaki linke dokunursan Safari&apos;de açılır. Uygulamadan giriyorsan kodu buraya yaz.
        </p>
      </div>
    </form>
  );
}
