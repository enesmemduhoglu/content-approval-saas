"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * F6 — ekip paneli: üyeleri listeler, davet eder, üye çıkarır, bekleyen
 * davetleri gösterir.
 *
 * Silme onayı `window.confirm` ile değil, iki adımlı inline onayla —
 * `ClientActions`/`PostActions` ile aynı gerekçe: confirm sayfayı bloklar ve
 * testten sürülemez.
 *
 * Yetki kontrolü SUNUCUDA (route handler'lar). Buradaki `isOwner` yalnızca
 * arayüzü sadeleştiriyor: yapamayacağı bir düğmeyi kimseye göstermemek.
 * Bu kontrole GÜVENİLMİYOR — istemci kodudur, değiştirilebilir.
 */

export type TeamMember = {
  id: string;
  email: string;
  name: string | null;
  role: "owner" | "member";
};

export type TeamInvite = {
  id: string;
  email: string;
  role: "owner" | "member";
  expiresAt: string;
  invitedByEmail: string | null;
  expired: boolean;
};

export function TeamPanel({
  members,
  invites,
  isOwner,
  currentMemberId,
}: {
  members: TeamMember[];
  invites: TeamInvite[];
  isOwner: boolean;
  /** Listede "sen" işareti için — kimin kendisi olduğu görünsün. */
  currentMemberId: string | null;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"owner" | "member">("member");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const router = useRouter();

  const ownerCount = members.filter((m) => m.role === "owner").length;

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviting) return;
    setInviting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/agency/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Bir hata oluştu, tekrar deneyin");
        return;
      }
      // Mailin gitmediğini SESSİZCE geçmiyoruz: aksi halde owner "davet
      // gönderdim" sanıp beklerdi. 16-17.08'de onay mailinde tam olarak bu
      // yaşandı — davet tarafında aynı hataya düşmeyelim.
      setNotice(
        data.emailSent
          ? `${email} adresine davet gönderildi.`
          : `Davet oluşturuldu ama E-POSTA GİTMEDİ. Bu bağlantıyı elle ilet: ${data.inviteUrl}`
      );
      setEmail("");
      router.refresh();
    } catch {
      setError("Bir hata oluştu, tekrar deneyin");
    } finally {
      setInviting(false);
    }
  }

  async function call(url: string, id: string, hataMesaji: string) {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? hataMesaji);
        return;
      }
      setConfirmingId(null);
      router.refresh();
    } catch {
      setError(hataMesaji);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="team-panel">
      {error && <p className="field-error">{error}</p>}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <ul className="team-list">
        {members.map((member) => {
          // Son owner'ı çıkarmak sunucuda da reddediliyor; düğmeyi burada
          // gizlemek reddin kullanıcıya hiç görünmemesi için.
          const sonOwner = member.role === "owner" && ownerCount <= 1;
          return (
            <li key={member.id} className="team-row">
              <span>
                <strong>{member.name ?? member.email}</strong>{" "}
                <span className="settings-hint">
                  {member.email} · {member.role === "owner" ? "Ajans sahibi" : "Ekip üyesi"}
                  {member.id === currentMemberId ? " · sen" : ""}
                </span>
              </span>
              {isOwner && !sonOwner && (
                confirmingId === member.id ? (
                  <span className="post-actions-row">
                    <button
                      type="button"
                      className="button-reject"
                      disabled={busyId === member.id}
                      onClick={() =>
                        call(
                          `/api/agency/members/${member.id}`,
                          member.id,
                          "Üye çıkarılamadı, tekrar deneyin"
                        )
                      }
                    >
                      {busyId === member.id ? "Çıkarılıyor…" : "Evet, çıkar"}
                    </button>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => setConfirmingId(null)}
                    >
                      Vazgeç
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="button-reject"
                    onClick={() => setConfirmingId(member.id)}
                  >
                    Ekipten çıkar
                  </button>
                )
              )}
              {isOwner && sonOwner && (
                <span className="settings-hint">Son sahip — çıkarılamaz</span>
              )}
            </li>
          );
        })}
      </ul>

      {invites.length > 0 && (
        <>
          <h3>Bekleyen davetler</h3>
          <ul className="team-list">
            {invites.map((invite) => (
              <li key={invite.id} className="team-row">
                <span>
                  <strong>{invite.email}</strong>{" "}
                  <span className="settings-hint">
                    {invite.role === "owner" ? "Ajans sahibi" : "Ekip üyesi"} ·{" "}
                    {invite.expired
                      ? "SÜRESİ DOLDU — yeniden davet et"
                      : `${new Date(invite.expiresAt).toLocaleDateString("tr-TR")} tarihine kadar geçerli`}
                  </span>
                </span>
                {isOwner && (
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={busyId === invite.id}
                    onClick={() =>
                      call(
                        `/api/agency/invites/${invite.id}`,
                        invite.id,
                        "Davet iptal edilemedi, tekrar deneyin"
                      )
                    }
                  >
                    {busyId === invite.id ? "İptal ediliyor…" : "Daveti iptal et"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {isOwner ? (
        <form onSubmit={invite} className="card form">
          <label>
            Davet edilecek e-posta
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ekip@ornek.com"
            />
          </label>
          <label>
            Rol
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as "owner" | "member")}
            >
              <option value="member">Ekip üyesi (post ve müşteri işleri)</option>
              <option value="owner">Ajans sahibi (ekibi de yönetir)</option>
            </select>
          </label>
          <p className="settings-hint">
            Davet edilen kişi, davetin gittiği e-postaya bağlı Google hesabıyla
            giriş yaptığında ekibe katılır. Başka bir hesapla giriş yaparsa davet
            kabul edilmez.
          </p>
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={inviting}>
              {inviting ? "Gönderiliyor…" : "Davet gönder"}
            </button>
          </div>
        </form>
      ) : (
        <p className="settings-hint">
          Ekibe yeni birini yalnızca ajans sahibi davet edebilir.
        </p>
      )}
    </div>
  );
}
