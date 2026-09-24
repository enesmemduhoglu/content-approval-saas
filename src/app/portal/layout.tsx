import type { Metadata } from "next";
import "./portal.css";

// Portal stilleri ayrı dosyada: `globals.css` ajans paneliyle ortak ve video
// kuyruğunun diğer fazlarıyla paralel değişebilir; portalın kuralları burada
// durursa birleştirme çakışması doğmaz. Renk/tipografi değişkenleri yine
// globals.css'ten (D7) geliyor — görsel dil ortak.
export const metadata: Metadata = {
  title: "Video Portalı",
  description: "Videolarını yükle, sırala, yayın saatlerini seç",
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
