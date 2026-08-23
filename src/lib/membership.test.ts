import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  acceptInviteAsSignedInUser,
  findMembership,
  normalizeEmail,
  resolveInviteView,
  resolveMembershipOnSignIn,
} from "@/lib/membership";
import { generateInviteToken, inviteExpiry } from "@/lib/tokens";
import { createAgency, createClient, createMember, resetDb } from "@tests/helpers/db";

/**
 * F6 — üyelik çözümünün tamamı. Bu dosyanın koruduğu asıl regresyon:
 * "bir Google hesabı = bir ajans" varsayımının geri gelmesi ve davet edilen
 * kişiye ajansa katılmak yerine bomboş yeni bir ajans açılması.
 */

function createInvite(
  agencyId: string,
  overrides: {
    email?: string;
    role?: "owner" | "member";
    expiresAt?: Date;
    acceptedAt?: Date | null;
    token?: string;
  } = {}
) {
  return db.agencyInvite.create({
    data: {
      agencyId,
      email: overrides.email ?? "davetli@ornek.com",
      role: overrides.role ?? "member",
      token: overrides.token ?? generateInviteToken(),
      expiresAt: overrides.expiresAt ?? inviteExpiry(),
      acceptedAt: overrides.acceptedAt ?? null,
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("normalizeEmail", () => {
  it("büyük/küçük harf ve boşluk farkını siler", () => {
    expect(normalizeEmail("  Ali@Ornek.COM ")).toBe("ali@ornek.com");
  });
});

describe("resolveMembershipOnSignIn — mevcut üye", () => {
  it("kendi ajansına düşer, YENİ ajans açılmaz", async () => {
    const agency = await createAgency();
    const member = await createMember(agency.id, {
      googleId: "google-mevcut",
      email: "uye@ornek.com",
    });

    const result = await resolveMembershipOnSignIn({
      googleId: "google-mevcut",
      email: "uye@ornek.com",
      name: "Üye",
    });

    expect(result.agencyId).toBe(agency.id);
    expect(result.memberId).toBe(member.id);
    expect(await db.agency.count()).toBe(1);
  });

  it("Google'daki ad değiştiyse üye satırını tazeler", async () => {
    const agency = await createAgency();
    await createMember(agency.id, { googleId: "google-ad", email: "ad@ornek.com" });

    await resolveMembershipOnSignIn({
      googleId: "google-ad",
      email: "AD@Ornek.com",
      name: "Yeni Ad",
    });

    const saved = await db.agencyMember.findUnique({ where: { googleId: "google-ad" } });
    expect(saved?.name).toBe("Yeni Ad");
    // E-posta normalize edilerek saklanır — davet eşleştirmesi buna güveniyor.
    expect(saved?.email).toBe("ad@ornek.com");
  });

  // F6 öncesinde `Agency.googleId` üzerinden çözülüyordu. Göç sonrası prod'un
  // hâli tam olarak bu: ajansın googleId'si duruyor AMA çözüm artık üyeden.
  it("çözüm Agency.googleId'ye DEĞİL AgencyMember'a bakar", async () => {
    const agency = await createAgency();
    await db.agencyMember.deleteMany({ where: { agencyId: agency.id } });
    // Ajansın kendi googleId'si hâlâ dolu ama üye satırı yok.
    const result = await resolveMembershipOnSignIn({
      googleId: agency.googleId!,
      email: agency.email,
    });
    // Üyelik olmadığı için eski ajansa DÜŞMEZ, yeni ajans açılır.
    expect(result.agencyId).not.toBe(agency.id);
  });
});

describe("resolveMembershipOnSignIn — yeni kullanıcı", () => {
  it("hiç üyeliği ve daveti yoksa kendine ajans açar ve owner olur", async () => {
    const result = await resolveMembershipOnSignIn({
      googleId: "google-yeni",
      email: "Yeni@Ornek.com",
      name: "Yeni Kişi",
    });

    expect(result.role).toBe("owner");
    const agency = await db.agency.findUnique({ where: { id: result.agencyId } });
    expect(agency).not.toBeNull();
    // Deprecate edilen kolon artık DOLDURULMUYOR (bkz. schema.prisma).
    expect(agency?.googleId).toBeNull();
    const member = await db.agencyMember.findUnique({ where: { googleId: "google-yeni" } });
    expect(member?.email).toBe("yeni@ornek.com");
  });

  // Geriye dönük uyum: aynı e-postayla ikinci bir ajansın açılabilmesi.
  // `Agency.email @unique` kaldırılmasaydı bu giriş unique ihlaliyle patlardı.
  it("aynı e-postaya sahip başka bir ajans varken de giriş yapılabilir", async () => {
    await createAgency({ email: "ayni@ornek.com" });
    const result = await resolveMembershipOnSignIn({
      googleId: "google-ikinci",
      email: "ayni@ornek.com",
    });
    expect(result.agencyId).toBeTruthy();
    expect(await db.agency.count()).toBe(2);
  });
});

describe("resolveMembershipOnSignIn — davet kabulü", () => {
  it("bekleyen davet varsa o ajansa ÜYE olarak katılır, yeni ajans açılmaz", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id, { email: "davetli@ornek.com" });

    const result = await resolveMembershipOnSignIn({
      googleId: "google-davetli",
      email: "davetli@ornek.com",
      name: "Davetli",
    });

    expect(result.agencyId).toBe(agency.id);
    expect(result.role).toBe("member");
    expect(await db.agency.count()).toBe(1);

    const saved = await db.agencyInvite.findUnique({ where: { id: invite.id } });
    expect(saved?.acceptedAt).not.toBeNull();
  });

  it("davet rolü owner ise owner olarak katılır", async () => {
    const agency = await createAgency();
    await createInvite(agency.id, { email: "ortak@ornek.com", role: "owner" });

    const result = await resolveMembershipOnSignIn({
      googleId: "google-ortak",
      email: "ortak@ornek.com",
    });
    expect(result.role).toBe("owner");
  });

  it("e-posta büyük/küçük harf farkı eşleşmeyi bozmaz", async () => {
    const agency = await createAgency();
    await createInvite(agency.id, { email: "karisik@ornek.com" });

    const result = await resolveMembershipOnSignIn({
      googleId: "google-karisik",
      email: "Karisik@Ornek.COM",
    });
    expect(result.agencyId).toBe(agency.id);
  });

  // ─── GÜVENLİK SINIRI ───────────────────────────────────────────────────
  // Davet linkini ele geçiren biri, davet BAŞKA bir adrese gitmişse ajansa
  // giremez. Kabul token'dan değil e-postadan gidiyor; testin ölçtüğü şey bu.
  it("EŞLEŞMEYEN e-postayla giriş yapan daveti KABUL EDEMEZ", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id, { email: "dogru@ornek.com" });

    const result = await resolveMembershipOnSignIn({
      googleId: "google-saldirgan",
      email: "saldirgan@ornek.com",
    });

    expect(result.agencyId).not.toBe(agency.id);
    expect(
      await db.agencyMember.count({ where: { agencyId: agency.id } })
    ).toBe(1); // yalnızca kurucu owner
    const saved = await db.agencyInvite.findUnique({ where: { id: invite.id } });
    expect(saved?.acceptedAt).toBeNull();
  });

  it("SÜRESİ DOLMUŞ davet kabul edilmez — kişiye kendi ajansı açılır", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id, {
      email: "gec@ornek.com",
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await resolveMembershipOnSignIn({
      googleId: "google-gec",
      email: "gec@ornek.com",
    });

    expect(result.agencyId).not.toBe(agency.id);
    const saved = await db.agencyInvite.findUnique({ where: { id: invite.id } });
    expect(saved?.acceptedAt).toBeNull();
  });

  it("ZATEN KULLANILMIŞ davet ikinci kez kabul edilmez", async () => {
    const agency = await createAgency();
    await createInvite(agency.id, {
      email: "tekrar@ornek.com",
      acceptedAt: new Date(),
    });

    const result = await resolveMembershipOnSignIn({
      googleId: "google-tekrar",
      email: "tekrar@ornek.com",
    });
    expect(result.agencyId).not.toBe(agency.id);
  });

  it("birden çok bekleyen davet varsa EN YENİSİ kazanır", async () => {
    const eski = await createAgency();
    const yeni = await createAgency();
    await createInvite(eski.id, { email: "cok@ornek.com" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createInvite(yeni.id, { email: "cok@ornek.com" });

    const result = await resolveMembershipOnSignIn({
      googleId: "google-cok",
      email: "cok@ornek.com",
    });
    expect(result.agencyId).toBe(yeni.id);
  });

  it("aynı ajanstan gelen diğer bekleyen davetler de kapanır", async () => {
    const agency = await createAgency();
    await createInvite(agency.id, { email: "iki@ornek.com" });
    await createInvite(agency.id, { email: "iki@ornek.com", token: generateInviteToken() });

    await resolveMembershipOnSignIn({ googleId: "google-iki", email: "iki@ornek.com" });

    expect(
      await db.agencyInvite.count({ where: { agencyId: agency.id, acceptedAt: null } })
    ).toBe(0);
  });

  it("zaten bir ajansın üyesiyse davet dikkate alınmaz (tek ajans kuralı)", async () => {
    const mevcut = await createAgency();
    const davet = await createAgency();
    await createMember(mevcut.id, { googleId: "google-mesgul", email: "mesgul@ornek.com" });
    await createInvite(davet.id, { email: "mesgul@ornek.com" });

    const result = await resolveMembershipOnSignIn({
      googleId: "google-mesgul",
      email: "mesgul@ornek.com",
    });
    expect(result.agencyId).toBe(mevcut.id);
  });
});

describe("findMembership — token tazeleme yolu", () => {
  it("üyelik varsa döner", async () => {
    const agency = await createAgency();
    await createMember(agency.id, { googleId: "google-var", email: "var@ornek.com" });
    expect((await findMembership("google-var"))?.agencyId).toBe(agency.id);
  });

  it("üyelik yoksa null döner ve ajans AÇMAZ", async () => {
    expect(await findMembership("google-yok")).toBeNull();
    expect(await db.agency.count()).toBe(0);
  });
});

/**
 * Davet DEVRİ — zaten bir ajansın üyesi olan biri başka bir ajansa geçer.
 *
 * Bu bloğun koruduğu regresyon: davetin "zaten üye" durumunda sessizce
 * yutulması. Prod'da tam olarak bu oldu — F6 öncesinden kalan boş bir ajansın
 * sahibi, asıl ajansa davet edildi, girdi ve hiçbir şey olmadı.
 */
describe("acceptInviteAsSignedInUser — devir", () => {
  it("boş ajansın tek owner'ı davet edildiği ajansa GEÇER", async () => {
    // `createAgency` ajansı KENDİ owner'ıyla birlikte kuruyor; prod'daki boş
    // kabuk da tam olarak böyle — tek kişilik, o kişi de owner. İkinci bir üye
    // eklemek senaryoyu bozardı.
    const bos = await createAgency({ name: "Boş Kabuk" });
    const hedef = await createAgency({ name: "Asıl Ajans" });
    const sahip = bos.members[0];
    const invite = await createInvite(hedef.id, { email: sahip.email });

    const result = await acceptInviteAsSignedInUser({
      googleId: sahip.googleId,
      email: sahip.email,
      token: invite.token,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.membership.agencyId).toBe(hedef.id);
    expect(result.leftAgencyId).toBe(bos.id);
    expect(result.leftAgencyOrphaned).toBe(true);

    // Tek üyelik kuralı korunuyor: eski satır silindi, yenisi hedefte.
    const uyelikler = await db.agencyMember.findMany({
      where: { googleId: sahip.googleId },
    });
    expect(uyelikler).toHaveLength(1);
    expect(uyelikler[0].agencyId).toBe(hedef.id);
    // Terk edilen ajans gerçekten üyesiz kaldı.
    expect(await db.agencyMember.count({ where: { agencyId: bos.id } })).toBe(0);
  });

  it("davetin rolüyle katılır", async () => {
    const bos = await createAgency();
    const hedef = await createAgency();
    await createMember(bos.id, { googleId: "google-rol", email: "rol@ornek.com" });
    const invite = await createInvite(hedef.id, { email: "rol@ornek.com", role: "owner" });

    const result = await acceptInviteAsSignedInUser({
      googleId: "google-rol",
      email: "rol@ornek.com",
      token: invite.token,
    });
    expect(result.ok && result.membership.role).toBe("owner");
  });

  it("daveti KAPATIR — ikinci kabul denemesi düşer", async () => {
    const bos = await createAgency();
    const hedef = await createAgency();
    await createMember(bos.id, { googleId: "google-iki", email: "iki@ornek.com" });
    const invite = await createInvite(hedef.id, { email: "iki@ornek.com" });

    const ilk = await acceptInviteAsSignedInUser({
      googleId: "google-iki",
      email: "iki@ornek.com",
      token: invite.token,
    });
    expect(ilk.ok).toBe(true);

    // Aynı token, artık hedefin üyesi: "zaten üye" dalı olumlu dönmeli.
    const ikinci = await acceptInviteAsSignedInUser({
      googleId: "google-iki",
      email: "iki@ornek.com",
      token: invite.token,
    });
    expect(ikinci.ok).toBe(true);
    expect(ikinci.ok && ikinci.leftAgencyId).toBeNull();

    // Ama BAŞKA biri aynı token'ı kullanamaz — davet kapandı.
    const bosB = await createAgency();
    await createMember(bosB.id, { googleId: "google-baskasi", email: "iki@ornek.com" });
    const ucuncu = await acceptInviteAsSignedInUser({
      googleId: "google-baskasi",
      email: "iki@ornek.com",
      token: invite.token,
    });
    expect(ucuncu).toEqual({ ok: false, reason: "invite_unavailable" });
  });

  it("DOLU ajansın son owner'ı devredemez — veri sahipsiz kalmasın", async () => {
    const dolu = await createAgency();
    const hedef = await createAgency();
    const sonOwner = dolu.members[0];
    await createClient(dolu.id);
    const invite = await createInvite(hedef.id, { email: sonOwner.email });

    const result = await acceptInviteAsSignedInUser({
      googleId: sonOwner.googleId,
      email: sonOwner.email,
      token: invite.token,
    });
    expect(result).toEqual({ ok: false, reason: "last_owner_with_data" });

    // Hiçbir şey değişmemiş olmalı: üyelik yerinde, davet hâlâ açık.
    const uyelik = await db.agencyMember.findUnique({
      where: { googleId: sonOwner.googleId },
    });
    expect(uyelik?.agencyId).toBe(dolu.id);
    expect((await db.agencyInvite.findUnique({ where: { id: invite.id } }))?.acceptedAt).toBeNull();
  });

  it("dolu ajansta İKİNCİ owner varsa devir serbest", async () => {
    const dolu = await createAgency();
    const hedef = await createAgency();
    // createAgency zaten bir owner üretiyor; ikinci owner olarak katılıyoruz.
    await createMember(dolu.id, {
      googleId: "google-ikinci-owner",
      email: "ikinci@ornek.com",
      role: "owner",
    });
    await createClient(dolu.id);
    const invite = await createInvite(hedef.id, { email: "ikinci@ornek.com" });

    const result = await acceptInviteAsSignedInUser({
      googleId: "google-ikinci-owner",
      email: "ikinci@ornek.com",
      token: invite.token,
    });
    expect(result.ok && result.membership.agencyId).toBe(hedef.id);
    // Eski ajans boş DEĞİL ve üyesi kaldı — temizlik adayı sayılmamalı.
    expect(result.ok && result.leftAgencyOrphaned).toBe(false);
  });

  it("dolu ajansın MEMBER'ı serbestçe devredebilir", async () => {
    const dolu = await createAgency();
    const hedef = await createAgency();
    await createMember(dolu.id, {
      googleId: "google-sade-uye",
      email: "sade@ornek.com",
      role: "member",
    });
    await createClient(dolu.id);
    const invite = await createInvite(hedef.id, { email: "sade@ornek.com" });

    const result = await acceptInviteAsSignedInUser({
      googleId: "google-sade-uye",
      email: "sade@ornek.com",
      token: invite.token,
    });
    expect(result.ok && result.membership.agencyId).toBe(hedef.id);
  });

  it("EŞLEŞMEYEN e-postayla kabul edilemez — link ele geçse bile", async () => {
    const bos = await createAgency();
    const hedef = await createAgency();
    await createMember(bos.id, { googleId: "google-yabanci", email: "yabanci@ornek.com" });
    const invite = await createInvite(hedef.id, { email: "davetli@ornek.com" });

    const result = await acceptInviteAsSignedInUser({
      googleId: "google-yabanci",
      email: "yabanci@ornek.com",
      token: invite.token,
    });
    expect(result).toEqual({ ok: false, reason: "email_mismatch" });
    expect((await db.agencyInvite.findUnique({ where: { id: invite.id } }))?.acceptedAt).toBeNull();
  });

  it("büyük/küçük harf farkı eşleşmeyi bozmaz", async () => {
    const bos = await createAgency();
    const hedef = await createAgency();
    await createMember(bos.id, { googleId: "google-harf", email: "harf@ornek.com" });
    const invite = await createInvite(hedef.id, { email: "Harf@Ornek.COM" });

    const result = await acceptInviteAsSignedInUser({
      googleId: "google-harf",
      email: " harf@ORNEK.com ",
      token: invite.token,
    });
    expect(result.ok && result.membership.agencyId).toBe(hedef.id);
  });

  it("SÜRESİ DOLMUŞ davet kabul edilmez", async () => {
    const bos = await createAgency();
    const hedef = await createAgency();
    await createMember(bos.id, { googleId: "google-sure", email: "sure@ornek.com" });
    const invite = await createInvite(hedef.id, {
      email: "sure@ornek.com",
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await acceptInviteAsSignedInUser({
      googleId: "google-sure",
      email: "sure@ornek.com",
      token: invite.token,
    });
    expect(result).toEqual({ ok: false, reason: "invite_unavailable" });
  });

  it("olmayan token", async () => {
    const result = await acceptInviteAsSignedInUser({
      googleId: "google-hayalet",
      email: "hayalet@ornek.com",
      token: "yok-boyle-bir-token",
    });
    expect(result).toEqual({ ok: false, reason: "invite_unavailable" });
  });

  it("hiç üyeliği olmayan biri de bu yoldan katılabilir (ajans AÇILMAZ)", async () => {
    const hedef = await createAgency();
    const invite = await createInvite(hedef.id, { email: "yeni@ornek.com" });
    const ajansSayisi = await db.agency.count();

    const result = await acceptInviteAsSignedInUser({
      googleId: "google-yepyeni",
      email: "yeni@ornek.com",
      token: invite.token,
    });
    expect(result.ok && result.membership.agencyId).toBe(hedef.id);
    expect(result.ok && result.leftAgencyId).toBeNull();
    expect(await db.agency.count()).toBe(ajansSayisi);
  });

  it("aynı ajanstan gelen diğer bekleyen davetler de kapanır", async () => {
    const bos = await createAgency();
    const hedef = await createAgency();
    await createMember(bos.id, { googleId: "google-coklu", email: "coklu@ornek.com" });
    const a = await createInvite(hedef.id, { email: "coklu@ornek.com" });
    const b = await createInvite(hedef.id, { email: "coklu@ornek.com" });

    await acceptInviteAsSignedInUser({
      googleId: "google-coklu",
      email: "coklu@ornek.com",
      token: a.token,
    });
    expect((await db.agencyInvite.findUnique({ where: { id: b.id } }))?.acceptedAt).not.toBeNull();
  });
});

/**
 * Sayfanın durum makinesi. React render'ı olmadan sınanıyor — sayfanın
 * kendisi bu dalları yalnızca yazıya çeviriyor.
 */
describe("resolveInviteView", () => {
  it("olmayan token → not_found", async () => {
    expect(
      await resolveInviteView({ token: "yok", signedInEmail: null, googleId: null })
    ).toEqual({ kind: "not_found" });
  });

  it("kullanılmış davet → used", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id, { acceptedAt: new Date() });
    const view = await resolveInviteView({
      token: invite.token,
      signedInEmail: null,
      googleId: null,
    });
    expect(view.kind).toBe("used");
  });

  it("süresi dolmuş davet → expired", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id, { expiresAt: new Date(Date.now() - 1000) });
    const view = await resolveInviteView({
      token: invite.token,
      signedInEmail: null,
      googleId: null,
    });
    expect(view.kind).toBe("expired");
  });

  it("girişsiz → anonymous", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id, { email: "kimse@ornek.com" });
    const view = await resolveInviteView({
      token: invite.token,
      signedInEmail: null,
      googleId: null,
    });
    expect(view.kind).toBe("anonymous");
  });

  it("yanlış hesapla giriş → wrong_account", async () => {
    const agency = await createAgency();
    const invite = await createInvite(agency.id, { email: "dogru@ornek.com" });
    const view = await resolveInviteView({
      token: invite.token,
      signedInEmail: "yanlis@ornek.com",
      googleId: "google-yanlis",
    });
    expect(view.kind).toBe("wrong_account");
  });

  it("zaten hedef ajansın üyesi → already_member", async () => {
    const agency = await createAgency();
    await createMember(agency.id, { googleId: "google-icerideki", email: "iceri@ornek.com" });
    const invite = await createInvite(agency.id, { email: "iceri@ornek.com" });
    const view = await resolveInviteView({
      token: invite.token,
      signedInEmail: "iceri@ornek.com",
      googleId: "google-icerideki",
    });
    expect(view.kind).toBe("already_member");
  });

  it("başka ajansın üyesi, eski ajans boş → transfer, blocked değil", async () => {
    const bos = await createAgency({ name: "Boş" });
    const hedef = await createAgency();
    await createMember(bos.id, { googleId: "google-gecici", email: "gecici@ornek.com" });
    const invite = await createInvite(hedef.id, { email: "gecici@ornek.com" });

    const view = await resolveInviteView({
      token: invite.token,
      signedInEmail: "gecici@ornek.com",
      googleId: "google-gecici",
    });
    expect(view.kind).toBe("transfer");
    if (view.kind !== "transfer") return;
    expect(view.blocked).toBe(false);
    expect(view.currentAgencyEmpty).toBe(true);
    expect(view.currentAgencyName).toBe("Boş");
  });

  it("dolu ajansın son owner'ı → transfer ama blocked", async () => {
    const dolu = await createAgency();
    const hedef = await createAgency();
    const sonOwner = dolu.members[0];
    await createClient(dolu.id);
    const invite = await createInvite(hedef.id, { email: sonOwner.email });

    const view = await resolveInviteView({
      token: invite.token,
      signedInEmail: sonOwner.email,
      googleId: sonOwner.googleId,
    });
    expect(view.kind).toBe("transfer");
    if (view.kind !== "transfer") return;
    expect(view.blocked).toBe(true);
  });

  it("giriş yapmış ama HİÇ üyeliği yok → transfer, kaybedecek bir şey yok", async () => {
    const hedef = await createAgency();
    const invite = await createInvite(hedef.id, { email: "uyeliksiz@ornek.com" });
    const view = await resolveInviteView({
      token: invite.token,
      signedInEmail: "uyeliksiz@ornek.com",
      googleId: "google-uyeliksiz",
    });
    expect(view.kind).toBe("transfer");
    if (view.kind !== "transfer") return;
    expect(view.blocked).toBe(false);
    expect(view.currentAgencyName).toBeNull();
  });
});
