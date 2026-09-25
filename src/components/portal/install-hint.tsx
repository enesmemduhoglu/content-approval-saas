"use client";

import { useEffect, useState } from "react";
import { IconClose, IconShare } from "@/components/portal/icons";

/** `localStorage` anahtarı: bant bir kez kapatılınca bu cihazda bir daha çıkmaz. */
export const INSTALL_HINT_KEY = "portal:kurulum-bandi-kapali";

export type InstallEnv = {
  userAgent: string;
  maxTouchPoints: number;
  /** iOS'a özgü `navigator.standalone` (ana ekrandan açılınca true). */
  navigatorStandalone: boolean | undefined;
  /** `(display-mode: standalone)` medya sorgusu. */
  displayModeStandalone: boolean;
  dismissed: boolean;
};

/**
 * Kurulum bandı yalnızca iOS Safari'de, uygulama olarak açılmamışken ve
 * kapatılmamışsa (V7-pwa §4.5). Diğer tarayıcılar ya kendi "Yükle" istemini
 * gösteriyor (Android Chrome) ya da ana ekrana ekleyemiyor (Instagram'ın
 * uygulama içi tarayıcısı) — orada "Paylaş → Ana Ekrana Ekle" demek yanlış yol
 * tarifi olurdu.
 *
 * iPadOS 13+ kendini masaüstü Mac olarak tanıtıyor; dokunmatik Mac olmadığı
 * için `maxTouchPoints > 1` onu ayırt ediyor.
 */
export function shouldShowInstallHint(env: InstallEnv): boolean {
  if (env.dismissed) return false;
  if (env.navigatorStandalone === true || env.displayModeStandalone) return false;
  const ua = env.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1);
  if (!ios) return false;
  const safari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|Instagram|FBAN|FBAV/.test(ua);
  return safari;
}

function readDismissed(): boolean {
  // Özel sekmede / engellenmiş depolamada erişim throw edebilir; o zaman bant
  // gösterilir (kapatma yalnızca bu oturum için geçerli olur).
  try {
    return window.localStorage.getItem(INSTALL_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Kuyruk ekranındaki "Uygulama olarak ekle" bandı. Yalnızca giriş yapılmış
 * sayfada çiziliyor: iOS adı ve ikonu ekleme ANINDA kopyalıyor, giriş
 * yapmadan eklenen uygulama müşterinin değil varsayılan kimliğiyle kalırdı
 * (V7-pwa §4.1).
 *
 * Karar ilk çizimden sonra (effect'te) veriliyor: sunucu tarayıcıyı bilmiyor,
 * ilk HTML'de bant olsaydı hidrasyon uyuşmazlığı ve masaüstünde bir anlık
 * görünüp kaybolan bir kutu olurdu.
 */
export function InstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    setShow(
      shouldShowInstallHint({
        userAgent: nav.userAgent,
        maxTouchPoints: nav.maxTouchPoints ?? 0,
        navigatorStandalone: nav.standalone,
        displayModeStandalone:
          typeof window.matchMedia === "function" &&
          window.matchMedia("(display-mode: standalone)").matches,
        dismissed: readDismissed(),
      })
    );
  }, []);

  if (!show) return null;

  function dismiss() {
    setShow(false);
    try {
      window.localStorage.setItem(INSTALL_HINT_KEY, "1");
    } catch {
      // Depolama yoksa bant yalnızca bu açılışta kapanır.
    }
  }

  return (
    <aside className="p-band" aria-label="Uygulama olarak ekle">
      <span className="p-band-icon">
        <IconShare size={18} />
      </span>
      <p className="p-band-text">
        <strong>Uygulama olarak ekle:</strong> Paylaş → Ana Ekrana Ekle
      </p>
      <button type="button" className="p-icon-btn" aria-label="Kapat" onClick={dismiss}>
        <IconClose size={16} />
      </button>
    </aside>
  );
}
