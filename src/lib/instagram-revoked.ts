import { db } from "@/lib/db";

/**
 * Meta'nın iptal ettiği (code=190) token'ı "süresi dolmuş" olarak işaretler.
 *
 * 2026-11-28: Furkan Teacher'ın token'ı şifre değişikliğiyle iptal edildi ama
 * `instagramTokenExpiry` hâlâ ileride görünüyordu. Tick'in "Instagram hazır
 * değil" kapısı yalnızca bitiş tarihine baktığı için kuyruk her slotta bir
 * video daha seçti, her biri 190 alıp `failed` oldu ve her seferinde müşteriye
 * ve ajansa ayrı e-posta gitti.
 *
 * Neden ayrı bir "iptal edildi" kolonu değil de bitiş tarihi: iptal edilmiş
 * token pratikte süresi dolmuş token'dır — ikisinin de tek çaresi panelden
 * yeniden bağlamak. Bitiş tarihini "şimdi"ye çekmek, o eşiğe bakan BÜTÜN
 * yolları şema göçü olmadan devreye sokar: tick kapısı (video harcanmaz,
 * reklam da), `publishApprovedPost`un hızlı hatası, portalın "Instagram
 * bağlantısı koptu" uyarısı, panelin token şeridi, furi'nin `expired` bayrağı
 * ve cron'un "elle bağlanmalı" kararı. Yeniden bağlama formu tarihi yeniden
 * yazdığı için işaret kendiliğinden kalkar.
 *
 * Koşullar:
 * - `instagramAccessToken` OKUNAN değerle aynı olmalı. Ajans tam o sırada
 *   yeni token bağladıysa eski token'ın hatası yenisini kilitlememeli.
 * - Tarih zaten geçmişse dokunulmaz: gerçek bitiş tarihi daha anlamlı bilgi.
 *
 * Throw ETMEZ: çağıranlar (`markFailed` öncesi yayın yolu, cron) bir işaretleme
 * hatası yüzünden asıl sonucu yazamaz hâle gelmemeli. `true` = işaret yazıldı.
 */
export async function expireRevokedToken(
  clientId: string,
  storedToken: string,
  now: Date = new Date()
): Promise<boolean> {
  try {
    const result = await db.client.updateMany({
      where: {
        id: clientId,
        instagramAccessToken: storedToken,
        OR: [{ instagramTokenExpiry: null }, { instagramTokenExpiry: { gt: now } }],
      },
      data: { instagramTokenExpiry: now },
    });
    if (result.count === 1) {
      console.error(
        `[instagram] ${clientId} müşterisinin token'ını Meta iptal etti (code=190) — ` +
          "süresi dolmuş işaretlendi, panelden yeniden bağlanmalı"
      );
    }
    return result.count === 1;
  } catch (error) {
    console.error(`[instagram] iptal edilen token işaretlenemedi: client=${clientId}`, error);
    return false;
  }
}
