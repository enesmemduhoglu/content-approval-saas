"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CodeLoginForm, requestLoginEmail } from "@/components/portal/code-login-form";

/**
 * Giriş e-postası isteği. Yanıt adres kayıtlı olsa da olmasa da aynı (sunucu
 * öyle döner); form da aynı akışa geçer — "bu adres bulunamadı" demek
 * kayıtlı müşterileri dışarıya listelemek olurdu.
 */
export function PortalLoginForm() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasCode, setHasCode] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setError(null);
    const result = await requestLoginEmail(email);
    setSending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSent(true);
  }

  // V7a: e-postada link + kod birlikte gelir. Kod adımı gönderimden hemen
  // sonra (iPhone ana ekran uygulamasında link oturum açmaz); "Kodum var" ise
  // maili başka bir cihazdan/sekmeden zaten istemiş kişi için.
  if (sent || hasCode) {
    return <CodeLoginForm initialEmail={sent ? email : undefined} />;
  }

  return (
    <form className="p-login-form" onSubmit={submit}>
      <p className="p-login-lead">
        Şifre yok: e-postana 6 haneli bir kod ve giriş linki gönderiyoruz. İkisi de 15 dakika geçerli.
      </p>
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
        {error && (
          <p className="p-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="p-login-foot">
        <button
          type="submit"
          className="p-btn p-btn--primary p-btn--lg p-btn--block"
          disabled={sending || !email.trim()}
        >
          {sending ? "Gönderiliyor…" : "Kod gönder"}
        </button>
        <button type="button" className="p-textbtn" onClick={() => setHasCode(true)}>
          Kodum var
        </button>
      </div>
    </form>
  );
}

/**
 * Linkteki token'ı tüketen buton. Link GET ile açıldığında token harcanmaz
 * (e-posta tarayıcıları linkleri önceden açıyor — bkz. api/portal/login/verify).
 */
export function PortalVerifyButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Giriş yapılamadı");
        return;
      }
      router.push("/portal");
      router.refresh();
    } catch {
      setError("Bağlantı hatası, tekrar dene");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-login-foot">
      {error && (
        <p className="p-error" role="alert">
          {error} <a href="/portal/giris">Yeni kod iste</a>
        </p>
      )}
      <button
        type="button"
        className="p-btn p-btn--primary p-btn--lg p-btn--block"
        disabled={busy}
        onClick={verify}
      >
        {busy ? "Giriş yapılıyor…" : "Portala giriş yap"}
      </button>
    </div>
  );
}
