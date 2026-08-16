"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Müşteri satırındaki Instagram bağlama alanı.
 *
 * Token bir sırdır: `type="password"` ile girilir, sunucuya yalnızca YAZILIR,
 * hiçbir zaman geri okunmaz. Bu bileşen token'ın kendisini değil, sunucudan
 * gelen maskelenmiş ipucunu (`tokenHint`) gösterir.
 */

type Props = {
  clientId: string;
  clientName: string;
  connected: boolean;
  instagramUserId: string | null;
  /** "…AbCd" — kayıtlı token'ın son 4 karakteri. */
  tokenHint: string | null;
  /** ISO tarih ya da null. */
  tokenExpiry: string | null;
};

type FormError = { field?: string; message: string };

/** Long-lived Instagram token'ının tipik ömrü — bitiş tarihi alanına öneri olarak konur. */
const LONG_LIVED_TOKEN_DAYS = 60;

function suggestedExpiry(): string {
  const date = new Date(Date.now() + LONG_LIVED_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function InstagramForm({
  clientId,
  clientName,
  connected,
  instagramUserId,
  tokenHint,
  tokenExpiry,
}: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const router = useRouter();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const formData = new FormData(event.currentTarget);
    try {
      const res = await fetch(`/api/clients/${clientId}/instagram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: formData.get("accessToken"),
          instagramUserId: formData.get("instagramUserId"),
          tokenExpiry: formData.get("tokenExpiry"),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError({
          field: data.field,
          message: data.error ?? "Bir hata oluştu, tekrar deneyin",
        });
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDisconnect() {
    if (submitting) return;
    if (!confirm(`${clientName} için Instagram bağlantısı kaldırılsın mı?`)) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/instagram`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError({ message: data.error ?? "Bir hata oluştu, tekrar deneyin" });
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  const expired = tokenExpiry ? new Date(tokenExpiry).getTime() <= Date.now() : false;

  return (
    <div className="instagram-connect">
      <div className="instagram-status">
        {connected ? (
          <span className="status-badge publish-published">Instagram bağlı</span>
        ) : (
          <span className="status-badge status-draft">Instagram bağlı değil</span>
        )}
        {connected && (
          <span className="settings-hint">
            Hesap {instagramUserId} · token {tokenHint}
            {tokenExpiry && (
              <>
                {" · "}
                {expired ? "süresi doldu" : `bitiş ${formatExpiry(tokenExpiry)}`}
              </>
            )}
          </span>
        )}
        <button type="button" className="link-button" onClick={() => setOpen(!open)}>
          {open ? "Kapat" : connected ? "Token'ı değiştir" : "Instagram bağla"}
        </button>
        {connected && (
          <button
            type="button"
            className="link-button"
            onClick={handleDisconnect}
            disabled={submitting}
          >
            Bağlantıyı kaldır
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={handleSubmit} className="card form">
          <label>
            Instagram erişim token&apos;ı (long-lived)
            <input
              type="password"
              name="accessToken"
              required
              autoComplete="off"
              maxLength={500}
              placeholder="IGAA…"
            />
          </label>
          <p className="settings-hint">
            Token kaydedildikten sonra bir daha görüntülenemez; yalnızca son 4
            karakteri gösterilir.
          </p>
          {error?.field === "accessToken" && <p className="field-error">{error.message}</p>}
          <label>
            Hesap kimliği (boş bırakırsan token&apos;dan bulunur)
            <input
              type="text"
              name="instagramUserId"
              inputMode="numeric"
              defaultValue={instagramUserId ?? ""}
              placeholder="17841400000000000"
            />
          </label>
          {error?.field === "instagramUserId" && <p className="field-error">{error.message}</p>}
          <label>
            Token bitiş tarihi (opsiyonel)
            <input
              type="date"
              name="tokenExpiry"
              defaultValue={tokenExpiry ? tokenExpiry.slice(0, 10) : suggestedExpiry()}
            />
          </label>
          {error?.field === "tokenExpiry" && <p className="field-error">{error.message}</p>}
          {error && !error.field && <p className="field-error">{error.message}</p>}
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={submitting}>
              {submitting ? "Doğrulanıyor…" : "Bağla"}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Vazgeç
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
