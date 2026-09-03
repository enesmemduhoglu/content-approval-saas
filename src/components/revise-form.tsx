"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type FormError = { field?: string; message: string };

type Props = {
  postId: string;
  caption: string;
  images: { id: string; url: string }[];
};

/**
 * Revizyon formu (F10) — post oluşturma formunun eşi, alanları aynı sırada.
 *
 * Gövde `multipart/form-data`: ajans dosya yükleyebilsin diye. Dosya
 * seçilmezse alan boş gider ve sunucu görsellere DOKUNMAZ — "sadece metni
 * düzelttim" en sık senaryo, onu dosya seçmeye zorlamak turu ağırlaştırırdı.
 *
 * Başarıdan sonra otomatik yönlendirme YOK: mailin akıbeti (F5) bu ekranda
 * söylenmeli, panele atlayan bir kullanıcı "müşteriye gitti mi" sorusunu
 * kaybederdi.
 */
export function ReviseForm({ postId, caption, images }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [done, setDone] = useState<{ emailSent: boolean; emailError?: string } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/posts/${postId}/resubmit`, {
        method: "POST",
        body: new FormData(event.currentTarget),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError({ field: data.field, message: data.error ?? "Bir hata oluştu, tekrar deneyin" });
        return;
      }
      setDone({ emailSent: data.emailSent === true, emailError: data.emailError });
      // Panel bu postu artık "onay bekliyor" olarak göstermeli; kullanıcı
      // dönmeden önce arka planda tazelenmiş olsun.
      router.refresh();
    } catch {
      setError({ message: "Bir hata oluştu, tekrar deneyin" });
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="card form">
        <p role="status">
          {done.emailSent
            ? "Post onaya geri gönderildi, müşteriye e-posta gitti."
            : `Post onaya geri gönderildi ama müşteriye e-posta GİTMEDİ${
                done.emailError ? `: ${done.emailError}` : ""
              }. Panelden onay linkini kopyalayıp elle iletebilirsin.`}
        </p>
        <Link className="button-primary" href="/dashboard">
          Panele dön
        </Link>
      </div>
    );
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="card form" encType="multipart/form-data">
      {/* Müşterinin gördüğü hâl: ajans neyi değiştirdiğine bakarak karar
          versin, başka sekmede onay sayfasını açmak zorunda kalmasın. */}
      <div className="revise-media">
        {images.map((image, index) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={image.id}
            src={image.url}
            alt={`Mevcut görsel ${index + 1}/${images.length}`}
            className="revise-thumb"
          />
        ))}
      </div>
      {/* Dosya alanı katlı: açılmadıkça görsellere dokunulmadığı görünsün.
          Açık bir "değiştiriyorum" hareketi olmadan çoklu dosya seçtirmek,
          metni düzeltmeye gelen ajansa her seferinde yanıtlaması gereken bir
          soru sorardı. */}
      {replacing ? (
        <label>
          Yeni görseller (JPEG/PNG/WebP, görsel başına maks 10MB, en fazla 10 görsel)
          <input type="file" name="image" accept="image/jpeg,image/png,image/webp" multiple />
          <span className="post-note">
            Seçtiğin görseller mevcutların TAMAMININ yerine geçer; boş bırakırsan mevcutlar
            korunur.
          </span>
        </label>
      ) : (
        <button
          type="button"
          className="button-secondary"
          onClick={() => setReplacing(true)}
          disabled={submitting}
        >
          Görselleri değiştir
        </button>
      )}
      {error?.field === "image" && <p className="field-error">{error.message}</p>}
      <label>
        Caption
        <textarea
          name="caption"
          defaultValue={caption}
          maxLength={2000}
          rows={12}
          required
          aria-label="Post metni"
        />
      </label>
      {error?.field === "caption" && <p className="field-error">{error.message}</p>}
      <label>
        Müşteriye not (opsiyonel): ne değiştirdin?
        <textarea name="message" maxLength={2000} rows={3} aria-label="Müşteriye not" />
      </label>
      {error && !error.field && <p className="field-error">{error.message}</p>}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={submitting}>
          {submitting ? "Gönderiliyor…" : "Onaya geri gönder"}
        </button>
        <Link className="button-secondary" href="/dashboard">
          Vazgeç
        </Link>
      </div>
    </form>
  );
}
