"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Video yayını yoklaması. Görselde yayın onay isteğinin içinde bitiyor;
 * videoda Instagram transcode ettiği için tek istek yetmiyor ve post
 * `publishing`de kalıyor (bkz. api/approve/[token]/publish-status).
 *
 * Tavan neden var: Instagram bir videoyu dakikalarca işleyebilir ve sonsuza
 * kadar yoklamak müşteriyi hiç bitmeyen bir ekranda tutar. Süre dolunca
 * yoklama durur ve müşteriye "işlem sürüyor, sonra bak" denir — yayın arka
 * planda devam eder, emniyet ağı cron'u bitirir.
 */
const YOKLAMA_ARALIGI_MS = 5_000;
const YOKLAMA_TAVANI_MS = 3 * 60_000;

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
  // Yoklama tavana dayandı: yayın hâlâ sürüyor olabilir ama artık beklemiyoruz.
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const pollingRef = useRef(false);

  const publishing = result?.publishStatus === "publishing";

  useEffect(() => {
    if (!publishing || pollTimedOut) return;
    // İki yoklama döngüsünün üst üste binmesini engeller: effect bağımlılığı
    // `result` üzerinden her cevapta yeniden tetikleniyor.
    if (pollingRef.current) return;
    pollingRef.current = true;

    let iptal = false;
    const sonAn = Date.now() + YOKLAMA_TAVANI_MS;

    async function yokla() {
      while (!iptal && Date.now() < sonAn) {
        await new Promise((r) => setTimeout(r, YOKLAMA_ARALIGI_MS));
        if (iptal) return;
        try {
          const res = await fetch(`/api/approve/${token}/publish-status`, { method: "POST" });
          if (!res.ok) continue; // 429/5xx geçici olabilir, tavana kadar dene
          const data = (await res.json()) as Decision;
          if (iptal) return;
          // Terminal duruma gelindiyse döngü biter; `publishing` ise sürer.
          setResult((prev) => ({ ...prev, ...data }) as Decision);
          if (data.publishStatus !== "publishing") return;
        } catch {
          // Ağ hatası yoklamayı bitirmez — bir sonraki tur tekrar dener.
        }
      }
      if (!iptal) setPollTimedOut(true);
    }

    void yokla().finally(() => {
      pollingRef.current = false;
    });

    return () => {
      iptal = true;
    };
    // `result` bilerek bağımlılık DEĞİL: her cevapta effect'i yeniden kurmak
    // döngüyü baştan başlatırdı. Döngü kendi durumunu `sonAn` ile taşıyor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishing, pollTimedOut, token]);

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
          ? pollTimedOut
            ? // Yoklama tavanı doldu. "Başarısız" DEMİYORUZ çünkü değil: yayın
              // Instagram tarafında sürüyor ve emniyet ağı bitirecek. Müşteriye
              // yapabileceği tek şey söyleniyor.
              "Video Instagram'da hâlâ işleniyor. Bu sayfayı birazdan yenileyerek durumu görebilirsin."
            : "Video Instagram'da işleniyor, yayın birazdan tamamlanacak…"
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
