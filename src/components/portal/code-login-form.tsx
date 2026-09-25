"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * V7a — e-postadaki 6 haneli kodla giriş (`POST /api/portal/login/code`).
 *
 * iPhone'da ana ekran uygulamasının çerezleri Safari'den ayrı: e-postadaki
 * link Safari'de açılır ve uygulama giriş ekranında kalır. Kod ise uygulamanın
 * içinde yazılır. Mantık bu bileşende, görünüm sade — görsel tasarım sonra.
 *
 * Alan nitelikleri iOS için önemli:
 *  • `inputMode="numeric"`: sayı klavyesi (type="number" DEĞİL — baştaki
 *    sıfırı yutar, kaydırınca değer değiştirir);
 *  • `autoComplete="one-time-code"`: iOS, Mail'e gelen kodu klavyenin üstünde
 *    önerir; tek dokunuşla dolar.
 */
export function CodeLoginForm({ initialEmail }: { initialEmail?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = code.replace(/\D/g, "").slice(0, 6);
  const ready = digits.length === 6 && email.trim().length > 0;

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
      router.push("/portal");
      router.refresh();
    } catch {
      setError("Bağlantı hatası, tekrar dene");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} aria-label="Kodla giriş">
      {!initialEmail && (
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
      )}
      <label>
        E-postadaki 6 haneli kod
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          required
          value={digits}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button-primary" disabled={busy || !ready}>
        {busy ? "Giriş yapılıyor…" : "Kodla giriş yap"}
      </button>
    </form>
  );
}
