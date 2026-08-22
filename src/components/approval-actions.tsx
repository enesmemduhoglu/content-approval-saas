"use client";

import { useState } from "react";

type Decision = {
  status: string;
  publishStatus?: string;
  igPermalink?: string | null;
  publishError?: string | null;
};

export function ApprovalActions({
  token,
  instagramConnected = false,
  retryOnly = false,
  retryLabel = "Yayını tekrar dene",
}: {
  token: string;
  /** Müşteride Instagram bağlıysa onay aynı istekte yayını da tetikler. */
  instagramConnected?: boolean;
  /** Karar zaten verilmiş, yalnızca yayını çalıştıran buton. */
  retryOnly?: boolean;
  /** Yayın hiç denenmemişse "tekrar dene" demek yanıltıcı olur. */
  retryLabel?: string;
}) {
  // "revising" (F10) reddetmenin bir çeşidi değil, ayrı bir mod: müşteri postu
  // gömmüyor, düzeltilmesini istiyor. Aynı kutuyu paylaşsalardı müşteri "ne
  // yapmış oluyorum" sorusunu ancak butonun rengine bakarak yanıtlardı.
  const [mode, setMode] = useState<"idle" | "rejecting" | "revising">("idle");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function decide(action: "approve" | "reject" | "request_revision", isRetry = false) {
    // Çift tıklama koruması: istek uçuştayken veya karar verilmişken ikinci
    // istek atılmaz; butonlar da disabled (D6 double-submit).
    // Tek istisna: yayın başarısız olduysa "tekrar dene".
    if (submitting || (result && !isRetry)) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/approve/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          rejectionReason: action === "reject" && reason.trim() ? reason : undefined,
          revisionMessage:
            action === "request_revision" && reason.trim() ? reason : undefined,
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
      setResult(data as Decision);
    } catch {
      setError("Bir hata oluştu, tekrar deneyin");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    // retryOnly'de karar zaten verilmişti; mesaj yalnızca yayını anlatır.
    const decisionText = retryOnly
      ? ""
      : result.status === "revision_requested"
        ? // Revizyonda "kararın kaydedildi" demek yanlış olurdu: karar
          // ertelendi, sıra ajansta. Müşteriye SONRA ne olacağı söyleniyor.
          "Teşekkürler, düzeltme isteğin ajansa iletildi. Güncel hâli hazır olduğunda haber vereceğiz — aynı bağlantıdan bakabilirsin."
        : `Teşekkürler, kararın kaydedildi. ${
            result.status === "approved" ? "Post onaylandı." : "Post reddedildi."
          }`;
    const publishText =
      result.publishStatus === "published"
        ? "Instagram'da yayınlandı."
        : result.publishStatus === "publishing"
          ? "Yayın sürüyor."
          : // Mükerrer: aynı içerik zaten canlıda. Hata gibi gösterilmez ve
            // "tekrar dene" butonu çıkmaz — tekrarlamak sorunun kendisi.
            result.publishStatus === "duplicate"
            ? (result.publishError ?? "Bu içerik zaten Instagram'da yayında.")
            : "";

    return (
      <div className="approve-actions">
        {(decisionText || publishText) && (
          <p className="approve-confirmation" role="status">
            {[decisionText, publishText].filter(Boolean).join(" ")}
          </p>
        )}
        {(result.publishStatus === "published" ||
          result.publishStatus === "duplicate") &&
          result.igPermalink && (
            <a
              className="button-secondary"
              href={result.igPermalink}
              target="_blank"
              rel="noreferrer"
            >
              Instagram&apos;da gör
            </a>
          )}
        {result.publishStatus === "failed" && (
          <>
            <p className="field-error">
              {result.publishError ?? "Instagram'a yayınlanamadı."}
            </p>
            {error && <p className="field-error">{error}</p>}
            <button
              type="button"
              className="button-secondary"
              disabled={submitting}
              onClick={() => decide("approve", true)}
            >
              {submitting ? "Yayınlanıyor…" : "Yayını tekrar dene"}
            </button>
          </>
        )}
      </div>
    );
  }

  if (retryOnly) {
    return (
      <div className="approve-actions">
        {error && <p className="field-error">{error}</p>}
        <button
          type="button"
          className="button-secondary"
          disabled={submitting}
          onClick={() => decide("approve", true)}
        >
          {submitting ? "Yayınlanıyor…" : retryLabel}
        </button>
      </div>
    );
  }

  const approveLabel = instagramConnected ? "Onayla ve Yayınla" : "Onayla";
  const approveBusyLabel = instagramConnected ? "Yayınlanıyor…" : "Kaydediliyor…";

  return (
    <div className="approve-actions">
      {mode !== "idle" && (
        <label className="form" style={{ margin: 0 }}>
          {/* Revizyonda metin OPSİYONEL değil denecek kadar önemli — ajans "ne
              düzeltilecek" bilmeden hiçbir şey yapamaz. Yine de zorunlu
              tutulmuyor: boş bırakan müşteriyi duvara çarptırmaktansa ajansa
              "müşteriyle konuş" demek daha az kırıcı (bkz. ajans bildirimi). */}
          {mode === "revising"
            ? "Neyin değişmesini istiyorsun?"
            : "Reddetme sebebi (opsiyonel)"}
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
            {submitting ? approveBusyLabel : approveLabel}
          </button>
          {/* Sıralama bilinçli: onay, revizyon, red. Reddetmek en sert ve en
              nadir yol; "şu cümleyi değiştir" demek isteyen müşterinin tek
              çıkışı reddetmek olmasın diye araya bu düşüyor (F10). */}
          <button
            type="button"
            className="button-secondary"
            disabled={submitting}
            onClick={() => setMode("revising")}
          >
            Revizyon iste
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
            className={mode === "revising" ? "button-primary" : "button-reject"}
            disabled={submitting}
            onClick={() => decide(mode === "revising" ? "request_revision" : "reject")}
          >
            {submitting
              ? "Kaydediliyor…"
              : mode === "revising"
                ? "Düzeltme iste"
                : "Reddet"}
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
