import { sendRawEmail } from "@/lib/email";

/**
 * F11 — sistem uyarıları.
 *
 * Neden var: hatalar `console.error` ile Vercel loglarına gidiyordu ve kimseye
 * ulaşmıyordu. Cron sessizce patladığında, Resend bir gönderimi reddettiğinde
 * ya da yayın `failed` olduğunda bunu ancak biri panele/loglara bakarsa fark
 * ediyordu. 16-17.08'de tam olarak bu yüzden iki gün onay maili gitmedi.
 *
 * ─── Kime gider? ────────────────────────────────────────────────────────────
 * Bu uyarılar bir ajansa/müşteriye özgü DEĞİL — "cron çöktü", "yayın hattı
 * bozuk görünüyor" gibi SİSTEM SEVİYESİNDE sinyaller ve muhatabı platformu
 * işleten kişi (SaaS sahibi), tek bir kiracı (Agency) değil. `Agency.email`
 * depoda zaten başka bir amaçla kullanılıyor: o adres AJANSIN kendi
 * müşterisiyle ilgili bildirimleri alır (onay/red/link süresi — bkz.
 * `email.ts`deki `sendAgencyNoticeEmail`). Publish hatası zaten o yoldan
 * ilgili ajansa gidiyor (bkz. `approve/[token]/route.ts`). Buradaki uyarı
 * ONUN YERİNE geçmiyor, EK bir hat: "tek bir post değil, hattın kendisi
 * bozuk olabilir" sinyalini yakalayan operatör kutusu. Bu yüzden sabit bir
 * `ALERT_EMAIL` env değişkeni kullanılıyor — herhangi bir `Agency.email`e
 * yazmıyoruz. Tanımlı değilse uyarı SESSİZCE atlanır ama bu durum loglanır
 * (kullanıcının Vercel'e `ALERT_EMAIL` eklemesi gerekiyor, yoksa F11 hiçbir
 * yere gitmez).
 *
 * ─── Uyarı fırtınasına karşı bastırma ───────────────────────────────────────
 * Aynı hata anahtarı (`key`) için art arda gelen uyarılar `SUPPRESS_WINDOW_MS`
 * penceresi içinde tekilleştirilir — cron her müşteride/postta patlarsa
 * operatörün kutusu onlarca aynı maille dolmasın diye. `key` çağıran tarafından
 * seçilir; örn. yayın hatalarında hatanın kendisinden türetilir ki "aynı hata
 * tekrarlıyor" ile "farklı yeni bir hata" ayrışsın.
 *
 * SERVERLESS SINIRLAMASI (dürüstçe yazılıyor, çözülmüş gibi gösterilmiyor):
 * bu bastırma modül seviyesinde bir `Map` ile, yani PROCESS İÇİ bellekte
 * tutuluyor. Vercel'de her fonksiyon çağrısı aynı sıcak instance'a düşebilir
 * de düşmeyebilir de — instance'lar arasında bu state PAYLAŞILMAZ. Yani bu
 * mekanizma yalnızca "aynı sıcak instance üstünde art arda/hızlı tekrarlar"
 * için işe yarar (örn. bir cron koşusu içindeki döngüde aynı hatanın çok kez
 * oluşması). Soğuk başlangıçlarda ya da paralel instance'larda aynı hata için
 * yine de birden fazla mail gidebilir. Kalıcı/instance'lar-arası bastırma için
 * DB'de bir tablo ya da Redis gerekir — bu MVP'de yok; bu yorum o eksikliğin
 * bilerek kayda geçirilmiş hâli.
 */

const SUPPRESS_WINDOW_MS = 30 * 60 * 1000; // 30 dakika

// Yalnızca sıcak instance ömrü boyunca yaşar — bkz. yukarıdaki serverless notu.
const lastSentAt = new Map<string, number>();

export type AlertDetail = Record<string, string | number | boolean | null | undefined>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Uyarı gövdesindeki bir alanı sır olabilecek her şeyden temizler: bu modül
 * `detail` içinde ne geldiğine güvenmez, uzunluğu kırpar. Token/API anahtarı
 * gibi gerçek sırların hiç buraya PASS EDİLMEMESİ çağıranın sorumluluğu
 * (bkz. `IGError.report()` ve `refreshInstagramToken`deki `safeDetail` —
 * aynı disiplin burada da bekleniyor), ama yine de savunma amaçlı kırpılır.
 */
const MAX_DETAIL_VALUE_LEN = 300;

function formatDetail(detail: AlertDetail): string[] {
  return Object.entries(detail)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${String(value).slice(0, MAX_DETAIL_VALUE_LEN)}`);
}

/**
 * Sistem uyarısı gönderir. `key` aynı hata sınıfını tekilleştirmek için
 * kullanılır (bkz. bastırma notu). ASLA throw etmez — bir uyarının kendisi
 * patlarsa bile çağıran akış (cron, yayın) bundan etkilenmemeli; en kötü
 * ihtimalle `console.error`a düşer.
 */
export async function sendAlert(
  key: string,
  title: string,
  detail?: AlertDetail
): Promise<void> {
  try {
    const alertEmail = process.env.ALERT_EMAIL;
    if (!alertEmail) {
      console.error(`[alerts] ALERT_EMAIL tanımlı değil, uyarı atlandı (${key}): ${title}`);
      return;
    }

    const now = Date.now();
    const last = lastSentAt.get(key);
    if (last !== undefined && now - last < SUPPRESS_WINDOW_MS) {
      console.warn(
        `[alerts] ${key} bastırıldı — son ${Math.round(SUPPRESS_WINDOW_MS / 60000)} dk içinde ` +
          "aynı hata için zaten mail gitti"
      );
      return;
    }
    // Damga, gönderim denemesinden ÖNCE atılır: gönderim patlasa bile aynı
    // pencerede tekrar tekrar denemesin — asıl istenen "aynı hata için tek
    // mail" davranışı, gönderim başarısı garantisi değil.
    lastSentAt.set(key, now);

    const lines = [title, ...(detail ? formatDetail(detail) : [])];
    const text = lines.join("\n");
    const html = `<pre style="font-family: 'SF Mono', Menlo, monospace; white-space: pre-wrap; font-size: 13px;">${escapeHtml(
      text
    )}</pre>`;

    const result = await sendRawEmail(
      { to: alertEmail, subject: `[CAS uyarı] ${title}`, html, text },
      `sistem uyarısı (${key})`
    );
    if (!result.sent) {
      console.error(`[alerts] uyarı e-postası gönderilemedi (${key}): ${result.reason}`);
    }
  } catch (error) {
    // Uyarı gönderimi kendi başına asla akışı düşürmemeli.
    console.error(`[alerts] sendAlert beklenmeyen şekilde patladı (${key}):`, error);
  }
}
