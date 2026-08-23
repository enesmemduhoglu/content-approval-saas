import { db } from "@/lib/db";
import { normalizeEmail } from "@/lib/membership";
import {
  sendAgencyNoticeEmail,
  type AgencyNoticeInput,
  type EmailResult,
} from "@/lib/email";

/**
 * Ajans bildirimlerinin alıcı listesi.
 *
 * ─── Neden `Agency.email` TEK BAŞINA YETMİYOR ──────────────────────────────
 * `Agency.email` ajans KURULURKEN, kuran Google hesabından bir kez yazılıyor
 * ve bir daha hiç güncellenmiyor (bkz. `membership.ts > resolveMembershipOnSignIn`).
 * F6 ekip üyeliğini getirdiğinden beri o kolon "ajansı kim kullanıyor"
 * sorusunun cevabı değil, yalnızca "ajansı kim açmıştı" sorusunun cevabı:
 *
 *   - Sonradan davetle katılan üyeler hiçbir bildirim ALMIYORDU. Ekip
 *     özelliği vardı ama bildirimler F6 öncesindeki tek kullanıcılı dünyada
 *     kalmıştı.
 *   - Kurucu adresi eskimişse (ajans başka bir hesapla açılmış, kurucu
 *     ekipten çıkmış, davet devriyle ajans el değiştirmiş) bildirim kimsenin
 *     bakmadığı bir kutuya düşüyordu — ve `gonder()` "gitti" dediği için
 *     hiçbir yerde hata da görünmüyordu.
 *
 * 23.08.2026'da tam olarak bu yaşandı: müşteriye onay maili gitti, müşteri
 * onayladı, post Instagram'a çıktı; ajanstaki iki kullanıcının da hiçbirinden
 * haberi olmadı. Bu yüzden alıcı listesi artık ÜYELERDEN üretiliyor;
 * `Agency.email` listeye ekleniyor ama tek kaynak olmaktan çıkıyor.
 */
export async function agencyNoticeRecipients(
  agencyId: string,
  agencyEmail?: string | null
): Promise<string[]> {
  const members = await db.agencyMember.findMany({
    where: { agencyId },
    // owner'lar üstte: mailin `To` başlığında ilk görünen, işin sahibi olsun.
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: { email: true },
  });
  return tekillestir([agencyEmail, ...members.map((member) => member.email)]);
}

/**
 * Küçük harfe indirgeyip tekilleştirir. `Agency.email` ile üyenin adresi çok
 * defa AYNI kutu (ajansı açan kişi kendi ajansının ilk üyesi) — normalize
 * etmeden karşılaştırırsak aynı kişiye iki kez yazılmış bir `To` üretiriz.
 */
function tekillestir(adresler: (string | null | undefined)[]): string[] {
  const gorulen = new Set<string>();
  const sonuc: string[] = [];
  for (const adres of adresler) {
    if (!adres) continue;
    const anahtar = normalizeEmail(adres);
    if (!anahtar || gorulen.has(anahtar)) continue;
    gorulen.add(anahtar);
    sonuc.push(anahtar);
  }
  return sonuc;
}

/**
 * Ajans bildirimini EKİBİN TAMAMINA gönderir. Bütün ajans bildirimleri (post
 * onaya gitti, müşteri onayladı/reddetti/düzeltme istedi, link süresi doldu,
 * zamanlanmış yayın koştu) bu kapıdan geçer.
 *
 * `sendAgencyNoticeEmail` gibi ASLA throw etmez: bildirim bir yan etki,
 * çağıran akış (post oluşturma, onay, cron) buna bağımlı değil. Üye sorgusu
 * patlarsa bile bildirim tamamen kaybolmasın diye bilinen tek adrese düşülür.
 */
export async function notifyAgencyTeam(
  agencyId: string,
  input: Omit<AgencyNoticeInput, "to"> & {
    /** Çağıran zaten okumuşsa `Agency.email` — ekstra sorgu açmamak için. */
    agencyEmail?: string | null;
  }
): Promise<EmailResult> {
  const { agencyEmail, ...notice } = input;
  let alicilar: string[];
  try {
    alicilar = await agencyNoticeRecipients(agencyId, agencyEmail);
  } catch (error) {
    console.error("[agency-notify] üye listesi okunamadı:", error);
    alicilar = tekillestir([agencyEmail]);
  }
  if (alicilar.length === 0) {
    // Üyesiz VE e-postasız ajans gerçekte olmaması gereken bir durum; sessizce
    // geçmek yerine loglanıyor ki "bildirim neden gitmedi" sorusunun bir izi olsun.
    const reason = "ajansın bildirim adresi yok";
    console.warn(`[agency-notify] ${agencyId}: ${reason}, ${input.event} bildirimi atlandı`);
    return { sent: false, reason };
  }
  return sendAgencyNoticeEmail({ ...notice, to: alicilar });
}
