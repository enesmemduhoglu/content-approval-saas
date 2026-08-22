import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { findMembership, normalizeEmail, resolveMembershipOnSignIn } from "@/lib/membership";
import { generateInviteToken, inviteExpiry } from "@/lib/tokens";
import { createAgency, createMember, resetDb } from "@tests/helpers/db";

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
