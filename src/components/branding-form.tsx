"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  logoUrl: string | null;
  brandColor: string | null;
};

const DEFAULT_ACCENT = "#1e3a34";

export function BrandingForm({ logoUrl, brandColor }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const router = useRouter();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setSaved(false);
    const formData = new FormData(event.currentTarget);
    try {
      const res = await fetch("/api/agency", { method: "POST", body: formData });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Bir hata oluştu, tekrar deneyin");
        return;
      }
      setSaved(true);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card form">
      <label>
        Marka rengi (onay sayfası ve e-postadaki buton rengi)
        <input type="color" name="brandColor" defaultValue={brandColor ?? DEFAULT_ACCENT} />
      </label>
      <label>
        Logo (JPEG/PNG/WebP — onay sayfası başlığında ve e-postada görünür)
        <input type="file" name="logo" accept="image/jpeg,image/png,image/webp" />
      </label>
      {logoUrl && (
        <p className="notice">
          Mevcut logo:{" "}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoUrl} alt="Ajans logosu" className="settings-logo-preview" />
        </p>
      )}
      {error && <p className="field-error">{error}</p>}
      {saved && (
        <p className="notice" role="status">
          Kaydedildi.
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={submitting}>
          {submitting ? "Kaydediliyor…" : "Kaydet"}
        </button>
      </div>
    </form>
  );
}
