/**
 * V7a — service worker'ın ağ yokken gösterdiği sayfa (V7-pwa §4.6).
 *
 * Bu sayfa SW önbelleğine giren TEK HTML; bu yüzden:
 *  • oturum okumaz, müşteriye ait hiçbir şey göstermez — önbellekteki kopya
 *    kimin cihazında açılırsa açılsın aynı olmalı (SW onu zaten çerezsiz
 *    ister, K26);
 *  • stili satır içi: çevrimdışıyken `/_next/static` altındaki CSS/JS ve
 *    Google fontları yüklenemez (onları önbelleğe almıyoruz), sayfa onlarsız
 *    da okunaklı kalmalı. İkon da bu yüzden dosya değil satır içi SVG.
 *    "Tekrar dene" JS'siz düz bir link.
 *
 * Görünüm V7 mobil tasarım dilinde (krem zemin, lacivert mürekkep). Başlık
 * fontu Archivo önbellekte değilse sistem yazısına düşer — bilinçli.
 */
export const metadata = { title: "Çevrimdışı" };

const INK = "#0E2038";
const BG = "#FAF6E9";

export default function OfflinePage() {
  return (
    <main
      style={{
        boxSizing: "border-box",
        minHeight: "100vh",
        maxWidth: 440,
        margin: "0 auto",
        padding: "max(72px, calc(env(safe-area-inset-top) + 48px)) 24px max(40px, env(safe-area-inset-bottom))",
        fontFamily: "Figtree, system-ui, -apple-system, sans-serif",
        color: INK,
        background: BG,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 20,
      }}
    >
      {/* Kök layout'un gövde zemini harici CSS'ten geliyor; çevrimdışı o da yok. */}
      <style>{`html,body{margin:0;background:${BG}}`}</style>
      <span
        aria-hidden="true"
        style={{
          width: 88,
          height: 88,
          borderRadius: 26,
          background: "#F2EBD7",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke={INK}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 8.8a15 15 0 0 1 4.2-2.6M9.8 5.2A15 15 0 0 1 22 8.8M5 12.5a10 10 0 0 1 3.2-2M13.7 10.3A10 10 0 0 1 19 12.5M8.5 16a5 5 0 0 1 7 0M12 20h.01M3 3l18 18" />
        </svg>
      </span>
      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.6, color: "#C2410C" }}>
        ÇEVRİMDIŞI
      </span>
      <h1
        style={{
          margin: 0,
          fontFamily: "Archivo, 'Arial Narrow', system-ui, sans-serif",
          fontStretch: "78%",
          fontWeight: 850,
          fontSize: 34,
          lineHeight: 1.02,
        }}
      >
        İnternet bağlantısı yok
      </h1>
      <p style={{ fontSize: 15, lineHeight: 1.5, color: "#5B6472", margin: 0 }}>
        Kuyruğunu görmek ve video yüklemek için bağlantı gerekiyor. Bağlantı gelince tekrar dene.
      </p>
      <a
        href="/portal"
        style={{
          marginTop: 12,
          boxSizing: "border-box",
          width: "100%",
          height: 56,
          borderRadius: 16,
          background: INK,
          color: BG,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 700,
          fontSize: 16,
          textDecoration: "none",
        }}
      >
        Tekrar dene
      </a>
    </main>
  );
}
