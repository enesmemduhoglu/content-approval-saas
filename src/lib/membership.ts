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

/**
 * Davet DEVRİ — zaten bir ajansın üyesi olan biri başka bir ajansa geçer.
 *
 * ─── Neden ayrı bir fonksiyon, neden girişe eklenmedi ──────────────────────
 * `resolveMembershipOnSignIn` mevcut üyeyi görünce oracıkta dönüyor ve davete
 * hiç bakmıyor; bu BİLİNÇLİ ve öyle kalıyor. Girişin sessizce ajans
 * değiştirmesi, "bir daveti tıkladım, kendi ajansımdan düştüm" demek olurdu —
 * hem de kullanıcı hiçbir şey onaylamadan. Devir bu yüzden AYRI ve AÇIK bir
 * eylem: kullanıcı `/invite/<token>` sayfasında ne kaybedeceğini görüp
 * düğmeye basar.
 *
 * ─── Neden "devir", çoklu üyelik değil ─────────────────────────────────────
 * `AgencyMember.googleId` `@unique`: bir Google hesabı tam olarak bir ajansa
 * ait. Bu kısıt `session.agencyId`in düz bir string kalmasını sağlayan şey —
 * çoklu üyelik, aktif ajans seçimi ve 78 çağrı yerinin yeniden düşünülmesi
 * demek. Devir, o sözleşmeyi bozmadan davetin işlemesini sağlıyor.
 *
 * ─── Güvenlik: token değil, yine E-POSTA karar veriyor ─────────────────────
 * Token yalnızca "hangi davet" sorusunu cevaplıyor. Kabul koşulu, giriş
 * yapılmış hesabın e-postasının davetin adresiyle eşleşmesi — linki ele
 * geçiren yabancı, kendi hesabıyla girip devri tetikleyemez.
 */
export type InviteAcceptFailure =
  /** Token yok, süresi dolmuş ya da davet zaten kullanılmış. */
  | "invite_unavailable"
  /** Giriş yapılmış hesap davetin gittiği adres değil. */
  | "email_mismatch"
  /** Dolu bir ajansın son owner'ı: çıkarsa müşteri ve postlar sahipsiz kalır. */
  | "last_owner_with_data";

export type InviteAcceptResult =
  | {
      ok: true;
      membership: Membership;
      /** Devir olduysa terk edilen ajansın id'si; ilk katılımsa null. */
      leftAgencyId: string | null;
      /** Terk edilen ajans üyesiz VE boş kaldıysa true — temizlik için sinyal. */
      leftAgencyOrphaned: boolean;
    }
  | { ok: false; reason: InviteAcceptFailure };

export async function acceptInviteAsSignedInUser(input: {
  googleId: string;
  email: string;
  name?: string | null;
  token: string;
}): Promise<InviteAcceptResult> {
  const email = normalizeEmail(input.email);
  const name = input.name ?? null;

  return db.$transaction(async (tx) => {
    const invite = await tx.agencyInvite.findUnique({
      where: { token: input.token },
      select: {
        id: true,
        agencyId: true,
        email: true,
        role: true,
        agency: { select: { name: true } },
      },
    });
    // Durum kontrolleri (süre/kullanılmışlık) burada DEĞİL, aşağıdaki koşullu
    // UPDATE'te: önce-oku-sonra-yaz iki eşzamanlı kabulün ikisini de geçirirdi.
    if (!invite) return { ok: false as const, reason: "invite_unavailable" as const };
    if (normalizeEmail(invite.email) !== email) {
      return { ok: false as const, reason: "email_mismatch" as const };
    }

    const current = await tx.agencyMember.findUnique({
      where: { googleId: input.googleId },
      select: { id: true, agencyId: true, role: true },
    });

    // Zaten hedef ajanstaysa: davet kaydını kapat ve olumlu dön. Kullanıcı
    // mailini geç açtığında ölü bir hata görmesin — istenen durum zaten var.
    if (current && current.agencyId === invite.agencyId) {
      await tx.agencyInvite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      return {
        ok: true as const,
        membership: {
          memberId: current.id,
          agencyId: current.agencyId,
          agencyName: invite.agency.name,
          role: current.role,
        },
        leftAgencyId: null,
        leftAgencyOrphaned: false,
      };
    }

    // VERİ SAHİPSİZ KALMASIN. Dolu bir ajansın tek owner'ı çıkarsa o ajansa
    // bir daha kimse davet edemez, kimse üye çıkaramaz ve panelden kurtarma
    // yolu kalmaz — `members.removeById`deki `last_owner` korumasının aynısı.
    // Ama BOŞ ajans için gevşetiliyor: kaybedilecek bir şey yoksa (0 müşteri,
    // 0 post) kullanıcıyı kendi boş kabuğunda tutmanın anlamı yok. Bu depoda
    // F6 öncesinden kalan tam olarak böyle bir kabuk var.
    let leftAgencyOrphaned = false;
    if (current) {
      const [ownerCount, memberCount, clientCount, postCount] = await Promise.all([
        tx.agencyMember.count({ where: { agencyId: current.agencyId, role: "owner" } }),
        tx.agencyMember.count({ where: { agencyId: current.agencyId } }),
        tx.client.count({ where: { agencyId: current.agencyId } }),
        tx.post.count({ where: { agencyId: current.agencyId } }),
      ]);
      const empty = clientCount === 0 && postCount === 0;
      if (current.role === "owner" && ownerCount <= 1 && !empty) {
        return { ok: false as const, reason: "last_owner_with_data" as const };
      }
      leftAgencyOrphaned = empty && memberCount <= 1;
    }

    // KOŞULLU UPDATE = kabul kilidi. `count === 0` ise davet ya süresi dolmuş,
    // ya başkası (aynı hesabın ikinci sekmesi) az önce kabul etmiş. Tek kazanan
    // garantisi buradan geliyor; devir ancak bu satır düştükten sonra yapılır.
    const claimed = await tx.agencyInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count === 0) {
      return { ok: false as const, reason: "invite_unavailable" as const };
    }

    // Eski üyelik SİLİNİYOR, `agencyId` güncellenmiyor: silip yaratmak
    // `createdAt`i tazeliyor, böylece panelde "ekibe katılma tarihi" sütunu
    // devir tarihini gösteriyor — eski ajansa katılma tarihini değil.
    if (current) {
      await tx.agencyMember.delete({ where: { id: current.id } });
    }
    const member = await tx.agencyMember.create({
      data: { agencyId: invite.agencyId, googleId: input.googleId, email, name, role: invite.role },
    });

    // Aynı kişiye aynı ajanstan gitmiş diğer bekleyen davetler artık anlamsız
    // (bkz. `resolveMembershipOnSignIn` içindeki aynı temizlik).
    await tx.agencyInvite.updateMany({
      where: { email, agencyId: invite.agencyId, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });

    return {
      ok: true as const,
      membership: {
        memberId: member.id,
        agencyId: member.agencyId,
        agencyName: invite.agency.name,
        role: member.role,
      },
      leftAgencyId: current?.agencyId ?? null,
      leftAgencyOrphaned,
    };
  });
}

/**
 * `/invite/<token>` sayfasının çizim durumu. Sayfa hiçbir şey yazmıyor; ne
 * göstereceğine bu fonksiyonun döndürdüğü duruma bakarak karar veriyor.
 * Kararı sayfadan ayırmanın sebebi test edilebilirlik: yedi dallı durum
 * makinesi React render'ı olmadan sınanabiliyor.
 */
export type InviteViewState =
  | { kind: "not_found" }
  | { kind: "used" }
  | { kind: "expired"; agencyName: string | null }
  /** Giriş yapılmamış: davet geçerli, kullanıcı önce Google'a gitmeli. */
  | {
      kind: "anonymous";
      agencyName: string | null;
      email: string;
      role: AgencyRole;
      invitedByEmail: string | null;
    }
  /** Giriş yapılmış ama BAŞKA hesapla — davet bu adresle kabul edilemez. */
  | { kind: "wrong_account"; agencyName: string | null; email: string; signedInAs: string }
  /** Zaten hedef ajansın üyesi — yapacak bir şey yok, panele. */
  | { kind: "already_member" }
  /** Devir onayı: başka bir ajanstan geliyor, ne kaybedeceğini görsün. */
  | {
      kind: "transfer";
      agencyName: string | null;
      role: AgencyRole;
      invitedByEmail: string | null;
      currentAgencyName: string | null;
      currentAgencyEmpty: boolean;
      /** Devir şimdiden imkânsız (dolu ajansın son owner'ı) — düğme gösterilmez. */
      blocked: boolean;
    };

export async function resolveInviteView(input: {
  token: string;
  signedInEmail: string | null;
  googleId: string | null;
}): Promise<InviteViewState> {
  const invite = await db.agencyInvite.findUnique({
    where: { token: input.token },
    select: {
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      invitedByEmail: true,
      agencyId: true,
      agency: { select: { name: true } },
    },
  });
  if (!invite) return { kind: "not_found" };
  if (invite.acceptedAt) return { kind: "used" };
  if (invite.expiresAt.getTime() <= Date.now()) {
    return { kind: "expired", agencyName: invite.agency.name };
  }

  const signedInEmail = input.signedInEmail ? normalizeEmail(input.signedInEmail) : null;
  if (!signedInEmail || !input.googleId) {
    return {
      kind: "anonymous",
      agencyName: invite.agency.name,
      email: invite.email,
      role: invite.role,
      invitedByEmail: invite.invitedByEmail,
    };
  }
  if (signedInEmail !== normalizeEmail(invite.email)) {
    return {
      kind: "wrong_account",
      agencyName: invite.agency.name,
      email: invite.email,
      signedInAs: signedInEmail,
    };
  }

  const current = await db.agencyMember.findUnique({
    where: { googleId: input.googleId },
    select: { agencyId: true, role: true, agency: { select: { name: true } } },
  });
  if (current?.agencyId === invite.agencyId) return { kind: "already_member" };

  // `blocked`, devrin çalışmayacağını ÖNCEDEN söylemek için: kullanıcıyı
  // düğmeye bastırıp hata göstermek yerine sebebi baştan yaz. Koşul
  // `acceptInviteAsSignedInUser`daki kontrolün aynısı; orası yine de kendi
  // kontrolünü yapıyor, burası yalnızca arayüz.
  let currentAgencyEmpty = true;
  let blocked = false;
  if (current) {
    const [ownerCount, clientCount, postCount] = await Promise.all([
      db.agencyMember.count({ where: { agencyId: current.agencyId, role: "owner" } }),
      db.client.count({ where: { agencyId: current.agencyId } }),
      db.post.count({ where: { agencyId: current.agencyId } }),
    ]);
    currentAgencyEmpty = clientCount === 0 && postCount === 0;
    blocked = current.role === "owner" && ownerCount <= 1 && !currentAgencyEmpty;
  }

  return {
    kind: "transfer",
    agencyName: invite.agency.name,
    role: invite.role,
    invitedByEmail: invite.invitedByEmail,
    currentAgencyName: current?.agency.name ?? null,
    currentAgencyEmpty,
    blocked,
  };
}
