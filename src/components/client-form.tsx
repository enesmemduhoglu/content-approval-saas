"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type FormError = { field?: string; message: string };

export function ClientForm() {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const formData = new FormData(event.currentTarget);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          email: formData.get("email"),
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
      formRef.current?.reset();
      setOpen(false);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="button-primary" onClick={() => setOpen(true)}>
        Yeni Müşteri
      </button>
    );
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="card form">
      <label>
        Müşteri adı
        <input type="text" name="name" required maxLength={200} />
      </label>
      {error?.field === "name" && <p className="field-error">{error.message}</p>}
      <label>
        E-posta (onay linki bu adrese gönderilir)
        <input type="email" name="email" required />
      </label>
      {error?.field === "email" && <p className="field-error">{error.message}</p>}
      {error && !error.field && <p className="field-error">{error.message}</p>}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={submitting}>
          {submitting ? "Ekleniyor…" : "Müşteriyi Ekle"}
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
  );
}
