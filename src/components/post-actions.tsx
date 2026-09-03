"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Bir post satırının yönetim işlemleri (F1 + F2 + F5).
 *
 * Metin düzenleme burada DEĞİL: hem "Düzenle" hem "Düzeltip tekrar gönder"
 * `/posts/[id]/edit` sayfasına götürür. Satır içi kutu yalnızca caption
 * düzenletiyordu; görseli değiştirmek isteyen ajansın hiçbir yolu yoktu.
 *
 * Silme onayı için `window.confirm` BİLEREK kullanılmıyor: tarayıcı modal'ı
 * sayfayı bloklar ve testten/otomasyondan sürülemez. Yerine iki adımlı inline
 * onay var — "Sil" bir kez, "Evet, sil" ikinci kez.
 */

type Props = {
  postId: string;
  status: "draft" | "pending" | "approved" | "rejected" | "revision_requested";
  publishStatus: string;
  /** Onay linkinin son kullanma tarihi (ISO) — yoksa link hiç yok. */
  linkExpiresAt: string | null;
};

type Busy = "idle" | "deleting" | "linking";

export function PostActions({
  postId,
  status,
  publishStatus,
  linkExpiresAt,
}: Props) {
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
          "Onay sayfasını açıp adresini elle iletebilirsin."
      );
    }
    router.refresh();
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
          // Satır içi kutu DEĞİL, düzenleme sayfası: revizyondaki gerekçenin
          // aynısı — düzeltilmesi istenen şey çoğu zaman görsel ve dar kutu
          // yalnızca metni düzenletiyordu (bkz. app/posts/[id]/edit).
          <Link
            className="button-secondary"
            href={`/posts/${postId}/edit`}
            data-edit-post={postId}
          >
            Düzenle
          </Link>
        )}
        {canResubmit && (
          // "Düzenle" ile aynı sayfa; postun durumu hangi işin yapılacağını
          // (sessiz düzeltme mi, onaya geri gönderme mi) belirliyor.
          <Link
            className="button-primary"
            href={`/posts/${postId}/edit`}
            data-resubmit-post={postId}
          >
            Düzeltip tekrar gönder
          </Link>
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
