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
  status: "draft" | "pending" | "approved" | "rejected" | "revision_requested";
  publishStatus: string;
  /** Düzenleme kutusunun başlangıç değeri — mevcut metin. */
  caption: string;
  /** Onay linkinin son kullanma tarihi (ISO) — yoksa link hiç yok. */
  linkExpiresAt: string | null;
  /** Açık revizyon isteğinin metni (F10) — düzeltme kutusunun üstünde durur. */
  revisionRequest?: string | null;
};

type Busy = "idle" | "saving" | "deleting" | "linking" | "resubmitting";

/**
 * Metin kutusunun hangi işi yaptığı. İkisi de caption düzenler ama SONUÇLARI
 * farklı: "caption" sessizce kaydeder, "resubmit" postu onaya geri yollar ve
 * müşteriye mail attırır (F10). Tek moda sıkıştırılsalardı ajans yazım hatası
 * düzeltirken istemeden müşteriyi dürterdi.
 */
type EditMode = "caption" | "resubmit";

export function PostActions({
  postId,
  status,
  publishStatus,
  caption,
  linkExpiresAt,
  revisionRequest = null,
}: Props) {
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<EditMode>("caption");
  const [agencyNote, setAgencyNote] = useState("");
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
  // Revizyon turu (F10): yayınlanmış postta bu yol KAPALI — sunucu da reddediyor
  // (metni burada değiştirmek Instagram'daki gönderiyi değiştirmez), buton hiç
  // çıkmasın ki ajans reddedilecek bir işlemi denemek zorunda kalmasın.
  const canResubmit = status === "revision_requested" && publishStatus !== "published";

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

  /** Düzeltip yeniden onaya gönder (F10). */
  async function resubmit() {
    if (editing === null) return;
    const data = await call(
      `/api/posts/${postId}/resubmit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caption: editing,
          message: agencyNote.trim() ? agencyNote : undefined,
        }),
      },
      "resubmitting"
    );
    if (!data) return;
    setEditing(null);
    setAgencyNote("");
    // Mailin akıbeti olduğu gibi aktarılır — "gönderildi" deyip gitmediğini
    // gizlemek, F5'in kapattığı deliği yeniden açardı.
    if (data.emailSent === true) {
      setNotice("Post onaya geri gönderildi, müşteriye e-posta gitti.");
    } else {
      setError(
        `Post onaya geri gönderildi ama müşteriye e-posta GİTMEDİ${
          data.emailError ? `: ${data.emailError}` : ""
        }. Onay linkini kopyalayıp elle iletebilirsin.`
      );
    }
    router.refresh();
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
    const resubmitMode = editMode === "resubmit";
    return (
      <div className="post-actions">
        {/* Müşterinin isteği düzeltme kutusunun HEMEN üstünde: ajans metni
            yazarken neye cevap verdiğini görsün, başka sekmeye bakmasın. */}
        {resubmitMode && revisionRequest && (
          <p className="rejection-reason">Müşterinin isteği: {revisionRequest}</p>
        )}
        <textarea
          className="post-edit-caption"
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          maxLength={2000}
          rows={4}
          aria-label="Post metni"
        />
        {resubmitMode && (
          <textarea
            className="post-edit-caption"
            value={agencyNote}
            onChange={(event) => setAgencyNote(event.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="Müşteriye not (opsiyonel): ne değiştirdin?"
            aria-label="Müşteriye not"
          />
        )}
        {error && <p className="field-error">{error}</p>}
        <div className="post-actions-row">
          <button
            type="button"
            className="button-primary"
            disabled={busy !== "idle"}
            onClick={resubmitMode ? resubmit : saveCaption}
          >
            {resubmitMode
              ? busy === "resubmitting"
                ? "Gönderiliyor…"
                : "Onaya geri gönder"
              : busy === "saving"
                ? "Kaydediliyor…"
                : "Kaydet"}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== "idle"}
            onClick={() => {
              setEditing(null);
              setAgencyNote("");
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
            onClick={() => {
              setEditMode("caption");
              setEditing(caption);
            }}
            data-edit-post={postId}
          >
            Düzenle
          </button>
        )}
        {canResubmit && (
          <button
            type="button"
            className="button-primary"
            disabled={busy !== "idle"}
            onClick={() => {
              setEditMode("resubmit");
              setEditing(caption);
            }}
            data-resubmit-post={postId}
          >
            Düzeltip tekrar gönder
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
