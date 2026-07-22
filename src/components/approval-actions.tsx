"use client";

import { useState } from "react";

export function ApprovalActions({ token }: { token: string }) {
  const [mode, setMode] = useState<"idle" | "rejecting">("idle");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function decide(action: "approve" | "reject") {
    // Çift tıklama koruması: istek uçuştayken veya karar verilmişken ikinci
    // istek atılmaz; butonlar da disabled (D6 double-submit).
    if (submitting || result) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/approve/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          rejectionReason: action === "reject" && reason.trim() ? reason : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && typeof data.status === "string") {
          setResult({ status: data.status });
        } else {
          setError(data.error ?? "Bir hata oluştu, tekrar deneyin");
        }
        return;
      }
      setResult({ status: data.status });
    } catch {
      setError("Bir hata oluştu, tekrar deneyin");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <p className="approve-confirmation" role="status">
        Teşekkürler, kararın kaydedildi.{" "}
        {result.status === "approved" ? "Post onaylandı." : "Post reddedildi."}
      </p>
    );
  }

  return (
    <div className="approve-actions">
      {mode === "rejecting" && (
        <label className="form" style={{ margin: 0 }}>
          Reddetme sebebi (opsiyonel)
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
            rows={3}
          />
        </label>
      )}
      {error && <p className="field-error">{error}</p>}
      {mode === "idle" ? (
        <>
          <button
            type="button"
            className="button-approve"
            disabled={submitting}
            onClick={() => decide("approve")}
          >
            {submitting ? "Kaydediliyor…" : "Onayla"}
          </button>
          <button
            type="button"
            className="button-reject"
            disabled={submitting}
            onClick={() => setMode("rejecting")}
          >
            Reddet
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="button-reject"
            disabled={submitting}
            onClick={() => decide("reject")}
          >
            {submitting ? "Kaydediliyor…" : "Reddet"}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={submitting}
            onClick={() => setMode("idle")}
          >
            Vazgeç
          </button>
        </>
      )}
    </div>
  );
}
