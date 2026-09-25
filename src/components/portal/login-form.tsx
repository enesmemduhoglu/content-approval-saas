"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CodeLoginForm } from "@/components/portal/code-login-form";

/**
 * Giriş linki isteği. Yanıt adres kayıtlı olsa da olmasa da aynı (sunucu
 * öyle döner); form da aynı mesajı gösterir — "bu adres bulunamadı" demek
 * kayıtlı müşterileri dışarıya listelemek olurdu.
 */
export function PortalLoginForm() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasCode, setHasCode] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Bir hata oluştu, tekrar dene");
        return;
      }
      setSent(data.message ?? "Bu adres kayıtlıysa bir giriş linki gelecek.");
    } catch {
      setError("Bağlantı hatası, tekrar dene");
    } finally {
      setSending(false);
    }
  }

  // V7a: e-postada link + kod birlikte gelir. Kod formu gönderimden sonra
  // hemen altta (iPhone ana ekran uygulamasında link oturum açmaz); "Kodum
  // var" ise maili başka bir cihazdan/sekmeden zaten istemiş kişi için.
  if (sent || hasCode) {
    return (
      <>
        {sent && (
          <p className="approve-confirmation" role="status">
            {sent} Gelen kutunu (ve spam klasörünü) kontrol et. Linke dokunabilir ya da
            e-postadaki kodu aşağıya yazabilirsin.
          </p>
        )}
        <CodeLoginForm initialEmail={sent ? email : undefined} />
      </>
    );
  }

  return (
    <form className="form" onSubmit={submit}>
      <label>
        E-posta adresin
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button-primary" disabled={sending || !email.trim()}>
        {sending ? "Gönderiliyor…" : "Giriş linki gönder"}
      </button>
      <button type="button" className="button-secondary" onClick={() => setHasCode(true)}>
        Kodum var
      </button>
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
    <div className="approve-actions">
      {error && (
        <p className="field-error" role="alert">
          {error} <a href="/portal/giris">Yeni link iste</a>
        </p>
      )}
      <button type="button" className="button-primary" disabled={busy} onClick={verify}>
        {busy ? "Giriş yapılıyor…" : "Portala giriş yap"}
      </button>
    </div>
  );
}
