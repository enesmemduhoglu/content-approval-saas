"use client";

import { useState } from "react";

type PortalUser = { id: string; email: string; lastLoginAt: string | null };

/**
 * Müşteriler sayfasındaki "Portal erişimi" bölümü (V3). Kapalı gelir ve
 * açılınca listeyi çeker: müşteri listesindeki her satır için sayfa
 * yüklenirken istek atmak, çoğu zaman bakılmayan bir bilgi için N istek olurdu.
 */
export function PortalAccess({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<PortalUser[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/clients/${clientId}/portal-users`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "Liste alınamadı");
      return;
    }
    setUsers(data.users);
  }

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && users === null) await load();
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/portal-users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Eklenemedi");
        return;
      }
      setEmail("");
      // Mail gitmediyse sessiz kalma: kullanıcı kaydı var, müşteri
      // /portal/giris'ten kendi linkini isteyebilir.
      setNotice(
        data.emailSent
          ? `${data.user.email} eklendi, giriş linki gönderildi.`
          : `${data.user.email} eklendi ama giriş maili GİTMEDİ. Müşteri /portal/giris sayfasından link isteyebilir.`
      );
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/portal-users/${userId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Kaldırılamadı");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="portal-access">
      <button type="button" className="link-button" aria-expanded={open} onClick={toggle}>
        Portal erişimi
      </button>
      {open && (
        <div className="portal-access-body">
          <p className="settings-hint">
            {clientName} video portalına bu adreslerle giriş yapar (şifresiz, e-posta linkiyle).
          </p>
          {users && users.length > 0 && (
            <ul className="team-list">
              {users.map((user) => (
                <li key={user.id} className="team-row">
                  <span>
                    {user.email}
                    <span className="settings-hint">
                      {user.lastLoginAt
                        ? `Son giriş: ${new Date(user.lastLoginAt).toLocaleDateString("tr-TR")}`
                        : "Henüz giriş yapmadı"}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="button-reject"
                    disabled={busy}
                    onClick={() => remove(user.id)}
                  >
                    Erişimi kaldır
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="form" onSubmit={add}>
            <label>
              E-posta ekle
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="button-secondary" disabled={busy || !email.trim()}>
                Erişim ver
              </button>
            </div>
          </form>
          {error && <p className="field-error">{error}</p>}
          {notice && <p className="post-actions-notice">{notice}</p>}
        </div>
      )}
    </div>
  );
}
