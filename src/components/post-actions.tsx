"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Bir post satırının yönetim işlemleri (F1 + F2 + F5).
 *
 * Silme onayı için `window.confirm` BİLEREK kullanılmıyor: tarayıcı modal'ı
 * sayfayı bloklar ve testten/otomasyondan sürülemez. Yerine iki adımlı inline
 * onay var — "Sil" bir kez, "Evet, sil" ikinci kez.
 */

type Props = {
  postId: string;
  status: "draft" | "pending" | "approved" | "rejected";
  publishStatus: string;
  /** Düzenleme kutusunun başlangıç değeri — mevcut metin. */
  caption: string;
  /** Onay linkinin son kullanma tarihi (ISO) — yoksa link hiç yok. */
  linkExpiresAt: string | null;
};

type Busy = "idle" | "saving" | "deleting" | "linking";

export function PostActions({
  postId,
  status,
  publishStatus,
  caption,
  linkExpiresAt,
}: Props) {
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const router = useRouter();

  const linkDead = linkExpiresAt === null || new Date(linkExpiresAt) <= new Date();
  const isPending = status === "pending";
  // Yayınlanmış post silinemez — sunucu da reddediyor, buton hiç çıkmasın ki
  // kullanıcı reddedilecek bir işlemi denemek zorunda kalmasın.
  const canDelete = publishStatus !== "published";
  // Karar verilmiş ama yayını bekleyen/patlamış postta onay sayfası hâlâ iş
  // görüyor ("Instagram'a yayınla" / "tekrar dene"); linki ölmüşse o yol da ölür.
  const canRelinkDecided =
    !isPending && (publishStatus === "failed" || publishStatus === "idle");

  async function call(url: string, init: RequestInit, busyState: Busy) {
    if (busy !== "idle") return null;
    setBusy(busyState);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Bir hata oluştu, tekrar deneyin");
        return null;
      }
      return data as Record<string, unknown>;
    } catch {
      setError("Bir hata oluştu, tekrar deneyin");
      return null;
    } finally {
      setBusy("idle");
    }
  }

  async function saveCaption() {
    if (editing === null) return;
    const data = await call(
      `/api/posts/${postId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption: editing }),
      },
      "saving"
    );
    if (data) {
      setEditing(null);
      router.refresh();
    }
  }

  async function remove() {
    const data = await call(`/api/posts/${postId}`, { method: "DELETE" }, "deleting");
    if (data) {
      setConfirmingDelete(false);
      router.refresh();
    }
  }

  async function sendLink(renew: boolean) {
    const data = await call(
      `/api/posts/${postId}/approval-link`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ renew }),
      },
      "linking"
    );
    if (!data) return;
    // Yanıtı olduğu gibi aktar: "gönderildi" deyip gitmediğini gizlemek tam da
    // bu özelliğin kapatmaya çalıştığı sorun.
    if (data.emailSent === true) {
      setNotice(data.renewed ? "Yeni link oluşturuldu ve e-posta gönderildi." : "E-posta tekrar gönderildi.");
    } else if (typeof data.emailSkipped === "string") {
      setNotice(`Link yenilendi. ${data.emailSkipped}`);
    } else {
      setError(
        `Link hazır ama e-posta GİTMEDİ${data.emailError ? `: ${data.emailError}` : ""}. ` +
          "Linki kopyalayıp elle iletebilirsin."
      );
    }
    router.refresh();
  }

  if (editing !== null) {
    return (
      <div className="post-actions">
        <textarea
          className="post-edit-caption"
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          maxLength={2000}
          rows={4}
          aria-label="Post metni"
        />
        {error && <p className="field-error">{error}</p>}
        <div className="post-actions-row">
          <button
            type="button"
            className="button-primary"
            disabled={busy !== "idle"}
            onClick={saveCaption}
          >
            {busy === "saving" ? "Kaydediliyor…" : "Kaydet"}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== "idle"}
            onClick={() => {
              setEditing(null);
              setError(null);
            }}
          >
            Vazgeç
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="post-actions">
      {error && <p className="field-error">{error}</p>}
      {notice && (
        <p className="post-actions-notice" role="status">
          {notice}
        </p>
      )}
      <div className="post-actions-row">
        {isPending && (
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== "idle"}
            onClick={() => sendLink(linkDead)}
          >
            {busy === "linking"
              ? "Gönderiliyor…"
              : linkDead
                ? "Yeni link gönder"
                : "Maili tekrar gönder"}
          </button>
        )}
        {!isPending && canRelinkDecided && linkDead && (
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== "idle"}
            onClick={() => sendLink(true)}
          >
            {busy === "linking" ? "Yenileniyor…" : "Linki yenile"}
          </button>
        )}
        {isPending && (
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== "idle"}
            onClick={() => setEditing(caption)}
            data-edit-post={postId}
          >
            Düzenle
          </button>
        )}
        {canDelete &&
          (confirmingDelete ? (
            <>
              <button
                type="button"
                className="button-reject"
                disabled={busy !== "idle"}
                onClick={remove}
              >
                {busy === "deleting" ? "Siliniyor…" : "Evet, sil"}
              </button>
              <button
                type="button"
                className="button-secondary"
                disabled={busy !== "idle"}
                onClick={() => setConfirmingDelete(false)}
              >
                Vazgeç
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button-reject"
              disabled={busy !== "idle"}
              onClick={() => setConfirmingDelete(true)}
            >
              Sil
            </button>
          ))}
      </div>
    </div>
  );
}
