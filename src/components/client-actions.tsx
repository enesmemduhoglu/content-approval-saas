"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Müşteri silme (F2). Post silmedeki gibi iki adımlı inline onay —
 * `window.confirm` sayfayı bloklar ve testten sürülemez.
 *
 * Postu olan müşteri sunucuda reddediliyor; buton yine de gösteriliyor çünkü
 * post sayısı burada bilinmiyor ve reddin gerekçesi ("şu kadar postu var")
 * kullanıcıya söylenmeye değer bir bilgi.
 */
export function ClientActions({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function remove() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Bir hata oluştu, tekrar deneyin");
        setConfirming(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Bir hata oluştu, tekrar deneyin");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="client-actions">
      {error && <p className="field-error">{error}</p>}
      {confirming ? (
        <div className="post-actions-row">
          <span className="settings-hint">
            <strong>{clientName}</strong> silinsin mi?
          </span>
          <button
            type="button"
            className="button-reject"
            disabled={deleting}
            onClick={remove}
          >
            {deleting ? "Siliniyor…" : "Evet, sil"}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={deleting}
            onClick={() => setConfirming(false)}
          >
            Vazgeç
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button-reject"
          onClick={() => setConfirming(true)}
        >
          Müşteriyi sil
        </button>
      )}
    </div>
  );
}
