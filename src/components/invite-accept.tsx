"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Davet devrinin onay düğmesi.
 *
 * Neden istemci bileşeni: devir bir YAZMA ve geri alınamaz (eski ajans
 * üyeliği silinir). Sayfanın kendisi hâlâ hiçbir şey yazmıyor — kullanıcı
 * bilinçli olarak bu düğmeye basmadan hiçbir şey olmuyor. `window.confirm`
 * kullanılmadı; depodaki diğer yıkıcı eylemler gibi (`TeamPanel`,
 * `PostActions`) onay satır içinde ve testten sürülebilir.
 */
export function InviteAccept({
  token,
  agencyName,
  role,
  currentAgencyName,
  currentAgencyEmpty,
}: {
  token: string;
  agencyName: string | null;
  role: "owner" | "member";
  currentAgencyName: string | null;
  /** Boşsa uyarı yumuşak, doluysa kaybın ne olduğu tek tek yazılır. */
  currentAgencyEmpty: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Davet kabul edilemedi");
        setBusy(false);
        return;
      }
      // Oturum tazelenemediyse panele atmak kullanıcıyı ESKİ ajansın
      // dashboard'una düşürürdü — devrin çalışmadığını sanır. Bu durumda
      // yönlendirme yerine ne olduğunu söyle.
      if (data.sessionRefreshed === false) {
        setNotice(
          "Ekibe katıldın. Oturumun birkaç dakika içinde yenilenecek; " +
            "hemen görmek istersen çıkış yapıp tekrar giriş yap."
        );
        setBusy(false);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Bağlantı hatası, tekrar dene");
      setBusy(false);
    }
  }

  if (notice) return <p>{notice}</p>;

  return (
    <>
      <p>
        Şu an <strong>{currentAgencyName ?? "başka bir ajansın"}</strong> ekibindesin.
        Bu daveti kabul edersen oradan çıkıp{" "}
        <strong>{agencyName ?? "bu ajansa"}</strong> ekibine{" "}
        {role === "owner" ? "ajans sahibi" : "ekip üyesi"} olarak geçersin.
        {currentAgencyEmpty
          ? " Eski ajansında müşteri ya da post yok, yani kaybedeceğin bir şey yok."
          : " Eski ajansın müşteri ve postları yerinde kalır ama sen artık onları göremezsin."}
      </p>
      {error && <p role="alert">{error}</p>}
      <button className="button-primary" onClick={accept} disabled={busy}>
        {busy ? "Katılıyor…" : "Kabul et ve ekibe geç"}
      </button>
    </>
  );
}
