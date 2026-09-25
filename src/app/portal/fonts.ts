import { Archivo, Figtree } from "next/font/google";

/**
 * Portalın yazı tipleri (mobil tasarım, V7). Ajans panelinin Fraunces/Public
 * Sans ikilisinden ayrı: portal müşterinin telefonundaki "uygulama" ve kendi
 * görsel dili var. Kök layout'a değil buraya konuldu ki ajans sayfaları bu
 * iki fontu hiç indirmesin.
 *
 * Archivo'nun `wdth` ekseni bilinçli olarak yükleniyor: başlıklar sıkışık
 * (`font-stretch: 78%`) — eksen olmadan tarayıcı sahte daraltma yapamaz ve
 * başlıklar normal genişlikte çıkardı.
 */
export const archivo = Archivo({
  subsets: ["latin", "latin-ext"],
  axes: ["wdth"],
  variable: "--p-font-display",
  display: "swap",
});

export const figtree = Figtree({
  subsets: ["latin", "latin-ext"],
  variable: "--p-font-body",
  display: "swap",
});
