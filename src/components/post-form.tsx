"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type FormError = { field?: string; message: string };

export function PostForm({ clients }: { clients: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  if (clients.length === 0) {
    return (
      <p className="notice">
        Post oluşturmadan önce <a href="/clients">bir müşteri ekle</a>.
      </p>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const formData = new FormData(event.currentTarget);
    try {
      const res = await fetch("/api/posts", { method: "POST", body: formData });
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
        Yeni Post
      </button>
    );
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="card form">
      <label>
        Müşteri
        <select name="clientId" required defaultValue="">
          <option value="" disabled>
            Müşteri seç
          </option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </label>
      {error?.field === "clientId" && <p className="field-error">{error.message}</p>}
      <label>
        Görsel (JPEG/PNG/WebP, maks 10MB)
        <input
          type="file"
          name="image"
          accept="image/jpeg,image/png,image/webp"
          required
        />
      </label>
      {error?.field === "image" && <p className="field-error">{error.message}</p>}
      <label>
        Caption
        <textarea name="caption" maxLength={2000} rows={4} required />
      </label>
      {error?.field === "caption" && <p className="field-error">{error.message}</p>}
      {error && !error.field && <p className="field-error">{error.message}</p>}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={submitting}>
          {submitting ? "Oluşturuluyor…" : "Postu Oluştur"}
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
