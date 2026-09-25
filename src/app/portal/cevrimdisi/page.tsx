/**
 * V7a — service worker'ın ağ yokken gösterdiği sayfa (V7-pwa §4.6).
 *
 * Bu sayfa SW önbelleğine giren TEK HTML; bu yüzden:
 *  • oturum okumaz, müşteriye ait hiçbir şey göstermez — önbellekteki kopya
 *    kimin cihazında açılırsa açılsın aynı olmalı (SW onu zaten çerezsiz
 *    ister);
 *  • stili satır içi: çevrimdışıyken `/_next/static` altındaki CSS/JS
 *    yüklenemez (onları önbelleğe almıyoruz), sayfa onlarsız da okunaklı
 *    kalmalı. "Tekrar dene" de JS'siz düz bir link.
 *
 * Görsel tasarım sonra; bu sürüm işlevsel ve sade.
 */
export const metadata = { title: "Çevrimdışı" };

export default function OfflinePage() {
  return (
    <main
      style={{
        maxWidth: 420,
        margin: "0 auto",
        padding: "max(48px, env(safe-area-inset-top)) 24px 48px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#1a1a1a",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>İnternet bağlantısı yok</h1>
      <p style={{ fontSize: 16, lineHeight: 1.5, color: "#6b6b6b", margin: "0 0 28px" }}>
        Kuyruğunu görmek ve video yüklemek için bağlantı gerekiyor. Bağlantı gelince
        tekrar dene.
      </p>
      <a
        href="/portal"
        style={{
          display: "inline-block",
          minHeight: 44,
          lineHeight: "44px",
          padding: "0 28px",
          borderRadius: 6,
          background: "#1e3a34",
          color: "#ffffff",
          textDecoration: "none",
          fontSize: 16,
        }}
      >
        Tekrar dene
      </a>
    </main>
  );
}
