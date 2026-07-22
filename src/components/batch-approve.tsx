"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function BatchApprove({ token, totalPending }: { token: string; totalPending: number }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function approveAll() {
    if (submitting || result !== null) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/approve/${token}/batch`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Bir hata oluştu, tekrar deneyin");
        return;
      }
      setResult(data.approved);
      router.refresh();
    } catch {
      setError("Bir hata oluştu, tekrar deneyin");
    } finally {
      setSubmitting(false);
    }
  }

  if (result !== null) {
    return (
      <p className="approve-confirmation" role="status">
        Teşekkürler! {result} post birden onaylandı.
      </p>
    );
  }

  return (
    <div className="batch-approve">
      {error && <p className="field-error">{error}</p>}
      {!confirming ? (
        <button
          type="button"
          className="button-secondary"
          onClick={() => setConfirming(true)}
        >
          Tümünü onayla ({totalPending} post)
        </button>
      ) : (
        <>
          <p className="batch-approve-warning">
            {totalPending} postun tamamı onaylanacak. Emin misin?
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="button-approve"
              disabled={submitting}
              onClick={approveAll}
            >
              {submitting ? "Onaylanıyor…" : `Evet, ${totalPending} postu onayla`}
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={submitting}
              onClick={() => setConfirming(false)}
            >
              Vazgeç
            </button>
          </div>
        </>
      )}
    </div>
  );
}
