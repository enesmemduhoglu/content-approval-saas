"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Ayarlar'ın en altındaki çıkış. Eskiden "Uygulama" kartının (ikon + ana
 * ekrana ekli mi + sürüm) altındaydı; kart kaldırıldı — yeni sürüm uyarısını
 * zaten layout'taki `UpdateBand` veriyor, kurulum ipucunu Kuyruk'taki bant.
 *
 * Portal oturumu NextAuth değil; çıkış kendi route'una POST.
 */
export function LogoutButton() {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  async function logout() {
    setLeaving(true);
    try {
      await fetch("/api/portal/logout", { method: "POST" });
    } finally {
      router.push("/portal/giris");
      router.refresh();
    }
  }

  return (
    <button type="button" className="p-btn p-btn--danger p-btn--block" onClick={logout} disabled={leaving}>
      {leaving ? "Çıkış yapılıyor…" : "Çıkış yap"}
    </button>
  );
}
