import type { AgencyRole } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * F6 — üyelik çözümü. `auth.ts`in jwt callback'i bu dosyaya yaslanıyor.
 *
 * ─── Neden bütün iş BURADA, auth katmanında bitiyor ────────────────────────
 * Depoda `agencyId` 78 yerde kullanılıyor ve IDOR koruması tamamen
 * `getScopedDb(session)` sözleşmesine dayanıyor. Üyeliği aşağı akışa taşımak
 * (her sorguya üyelik join'i) o 78 yerin hepsini dolaylamak, yani kapsam
 * filtresinin unutulabileceği 78 yeni yer açmak demekti. Bunun yerine
 * `googleId → AgencyMember → agencyId` zinciri TEK BİR yerde kuruluyor ve
 * token'a yine düz bir `agencyId` konuyor. Aşağı akıştaki hiçbir şey
 * değişmiyor; IDOR koruması aynen duruyor.
 */

/**
 * E-posta karşılaştırmalarının TEK yeri. Davet "Ali@Ornek.com"a gönderilip
 * Google "ali@ornek.com" döndürdüğünde eşleşme kaçarsa davetli ajansa
 * giremez ve bunun yerine kendisine boş bir ajans açılırdı — F6'nın
 * düzeltmeye çalıştığı hatanın ta kendisi.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export type Membership = {
  memberId: string;
  agencyId: string;
  agencyName: string | null;
  role: AgencyRole;
};

/**
 * Token TAZELEME yolu (yalnızca okuma): elindeki JWT'yi taşıyan kişi HÂLÂ
 * bir ajansın üyesi mi?
 *
 * Ajans AÇMAZ — bu bilinçli. Ekipten çıkarılmış birinin arka planda yapılan
 * bir doğrulama sırasında kendisine sessizce yepyeni bir ajans açılması,
 * "çıkardım" diyen owner için tam bir sürpriz olurdu. Çıkarılan kişi erişimini
 * kaybeder; yeniden GİRİŞ yaparsa (aşağıdaki fonksiyon) yeni bir kullanıcı
 * gibi muamele görür.
 */
export async function findMembership(googleId: string): Promise<Membership | null> {
  const member = await db.agencyMember.findUnique({
    where: { googleId },
    select: { id: true, agencyId: true, role: true, agency: { select: { name: true } } },
  });
  if (!member) return null;
  return {
    memberId: member.id,
    agencyId: member.agencyId,
    agencyName: member.agency.name,
    role: member.role,
  };
}

/**
 * GİRİŞ yolu. Üç senaryo, sırayla:
 *
 * 1. **Mevcut üye** → kendi ajansına düşer. Ad/e-posta değişmişse tazelenir
 *    (Google hesabının adı değişebilir; panelde eski adı göstermek istemeyiz).
 *
 * 2. **Bekleyen daveti olan biri** → davet edildiği ajansa ÜYE olarak katılır,
 *    yeni ajans AÇILMAZ. Kabul koşulları: e-posta eşleşmesi, süresi dolmamış,
 *    daha önce kabul edilmemiş. Bkz. aşağıdaki güvenlik notu.
 *
 * 3. **Hiç üyeliği ve daveti olmayan yeni biri** → kendisine yeni bir ajans
 *    açılır ve `owner` olur. BUGÜNKÜ DAVRANIŞ AYNEN KORUNDU. Alternatif
 *    "yalnızca davetliler girebilir" olurdu; onu seçmedik çünkü (a) ürün şu an
 *    kendi kendine kayıt olunan bir SaaS, davet duvarı koymak bir ürün kararı
 *    ve F6'nın konusu değil; (b) geriye dönük uyum: deploy sonrası ilk kez
 *    giren meşru bir kullanıcının kapıda kalması, çözdüğümüz sorundan daha
 *    büyük bir regresyon olurdu.
 *
 * ─── Güvenlik: davet neden TOKEN'la değil E-POSTAYLA kabul ediliyor ────────
 * Davet maili `/invite/<token>` linki taşıyor, ama kabul o token'dan
 * sorgulanmıyor — giriş yapılan Google hesabının e-postasından sorgulanıyor.
 * Token tabanlı kabulde linki ele geçiren herkes (iletilmiş bir mail, log'a
 * düşmüş bir URL, omuz üstünden okuma) ajansa girerdi. E-posta tabanlı
 * kabulde çalınan link hiçbir işe yaramaz: kabul edebilecek tek kişi davetin
 * gittiği kutunun sahibi.
 */
export async function resolveMembershipOnSignIn(input: {
  googleId: string;
  email: string;
  name?: string | null;
}): Promise<Membership> {
  const email = normalizeEmail(input.email);
  const name = input.name ?? null;

  const existing = await db.agencyMember.findUnique({
    where: { googleId: input.googleId },
    select: { id: true, agencyId: true, role: true, agency: { select: { name: true } } },
  });
  if (existing) {
    // Ad/e-posta değişmişse tazele. `updateMany` değil `update`: satırın var
    // olduğunu az önce okuduk ve `googleId` unique.
    await db.agencyMember.update({
      where: { googleId: input.googleId },
      data: { email, name },
    });
    return {
      memberId: existing.id,
      agencyId: existing.agencyId,
      agencyName: existing.agency.name,
      role: existing.role,
    };
  }

  const invite = await db.agencyInvite.findFirst({
    where: { email, acceptedAt: null, expiresAt: { gt: new Date() } },
    // Birden çok bekleyen davet varsa EN YENİSİ kazanır: en son gönderilen
    // davet, gönderenin en güncel niyetidir.
    orderBy: { createdAt: "desc" },
    select: { id: true, agencyId: true, role: true, agency: { select: { name: true } } },
  });

  if (invite) {
    const member = await db.$transaction(async (tx) => {
      const created = await tx.agencyMember.create({
        data: { agencyId: invite.agencyId, googleId: input.googleId, email, name, role: invite.role },
      });
      // Kabul damgası KOŞULLU yazılır: iki eşzamanlı giriş aynı daveti okuyup
      // ikisi de kabul etmeye kalkarsa yalnızca biri satırı günceller. Diğeri
      // zaten `AgencyMember.googleId` unique kısıtına takılır — iki katman.
      await tx.agencyInvite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      // Aynı kişiye aynı ajanstan gitmiş DİĞER bekleyen davetler artık
      // anlamsız; açık bırakılırsa panelde "bekliyor" görünüp kafa karıştırır.
      await tx.agencyInvite.updateMany({
        where: { email, agencyId: invite.agencyId, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      return created;
    });
    return {
      memberId: member.id,
      agencyId: member.agencyId,
      agencyName: invite.agency.name,
      role: member.role,
    };
  }

  // Yeni kullanıcı: ajans + owner üyeliği tek transaction'da. `Agency.googleId`
  // BİLEREK doldurulmuyor — o kolon artık deprecate (bkz. schema.prisma).
  const { agency, member } = await db.$transaction(async (tx) => {
    const agency = await tx.agency.create({ data: { email, name } });
    const member = await tx.agencyMember.create({
      data: { agencyId: agency.id, googleId: input.googleId, email, name, role: "owner" },
    });
    return { agency, member };
  });
  return {
    memberId: member.id,
    agencyId: agency.id,
    agencyName: agency.name,
    role: member.role,
  };
}
