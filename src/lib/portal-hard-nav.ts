/**
 * Girişten sonra portala TAM sayfa yüklemesiyle geçiş.
 *
 * `router.push` istemci tarafı geçiş yapar: giriş sayfası ile portal aynı
 * `/portal` layout'unu paylaştığı için layout'un `generateMetadata`'sı yeniden
 * koşmaz ve `<head>`'deki `apple-mobile-web-app-title` / `apple-touch-icon`
 * oturumsuz (varsayılan kimlik) halleriyle kalır. iOS "Ana Ekrana Ekle" adı ve
 * ikonu tam o etiketlerden, EKLEME ANINDA kopyalıyor — 2026-09-25'teki ilk
 * iPhone denemesinde uygulama bu yüzden "Kuyruk" adıyla eklendi. Tam yükleme,
 * sunucunun sayfayı oturumla baştan üretmesini sağlar.
 *
 * Ayrı modül: jsdom `window.location.assign`'ı gerçekten uygulamıyor; testler
 * bu fonksiyonu taklit edip çağrıldığını doğrular.
 */
export function goToPortalHome(): void {
  window.location.assign("/portal");
}
