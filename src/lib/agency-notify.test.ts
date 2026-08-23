import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bu dosyanın var olma sebebi somut bir olay: 23.08.2026'da bir post onaya
 * gitti, müşteri onayladı, post Instagram'a çıktı — ajanstaki İKİ kullanıcının
 * da hiçbirinden haberi olmadı. Sebep, bildirimlerin `Agency.email`e (ajansı
 * KURANIN adresi) gitmesi, ekibe değil. Aşağıdaki testlerin çoğu doğrudan o
 * senaryoyu sınıyor.
 */

vi.mock("@/lib/email", () => ({ sendAgencyNoticeEmail: vi.fn() }));

import { agencyNoticeRecipients, notifyAgencyTeam } from "./agency-notify";
import { sendAgencyNoticeEmail } from "@/lib/email";
import { db } from "@/lib/db";
import { createAgency, createMember, resetDb } from "@tests/helpers/db";

const mockNotice = vi.mocked(sendAgencyNoticeEmail);

beforeEach(async () => {
  await resetDb();
  mockNotice.mockReset();
  mockNotice.mockResolvedValue({ sent: true });
});

describe("agencyNoticeRecipients", () => {
  it("ajansı kuranın adresi ile üyeleri tek listede toplar", async () => {
    const agency = await createAgency();
    const uye = await createMember(agency.id, { email: "ekip@ornek.com" });

    await expect(agencyNoticeRecipients(agency.id, agency.email)).resolves.toEqual([
      agency.email,
      uye.email,
    ]);
  });

  // Asıl hata buydu: davetle katılan üye ekipte görünüyordu ama bildirimlerden
  // habersizdi. `Agency.email` üyeliği DEĞİL, ajansın açılışını anlatıyor.
  it("davetle katılan üye de bildirim listesine girer", async () => {
    const agency = await createAgency({ email: "kurucu@ornek.com" });
    await createMember(agency.id, { email: "davetli@ornek.com" });

    const alicilar = await agencyNoticeRecipients(agency.id, agency.email);
    expect(alicilar).toContain("davetli@ornek.com");
  });

  // Ajans el değiştirmiş ya da kurucu ekipten çıkmış olabilir: o hâlde
  // `Agency.email` artık kimsenin bakmadığı bir kutu. Yine de listede tutuluyor
  // (bilinen tek adres olduğu durumlar var) ama ekip artık ONUN peşine takılı
  // değil — kurucu düşse bile bildirim ekibe ulaşır.
  it("kurucu ekipten çıkmış olsa bile kalan üyeler bildirim alır", async () => {
    const agency = await createAgency({ email: "eskikurucu@ornek.com" });
    const kalan = await createMember(agency.id, { email: "kalan@ornek.com", role: "owner" });
    await db.agencyMember.deleteMany({ where: { agencyId: agency.id, email: agency.email } });

    const alicilar = await agencyNoticeRecipients(agency.id, agency.email);
    expect(alicilar).toContain(kalan.email);
  });

  it("aynı kutu iki kez yazılmaz — büyük/küçük harf farkı dahil", async () => {
    const agency = await createAgency({ email: "sahip@ornek.com" });
    await createMember(agency.id, { email: "SAHIP@ornek.com" });

    await expect(
      agencyNoticeRecipients(agency.id, "Sahip@Ornek.com")
    ).resolves.toEqual(["sahip@ornek.com"]);
  });

  it("owner'lar listenin başında olur — `To`da ilk görünen işin sahibi", async () => {
    const agency = await createAgency({ email: "kurucu@ornek.com" });
    await createMember(agency.id, { email: "calisan@ornek.com", role: "member" });
    await createMember(agency.id, { email: "ortak@ornek.com", role: "owner" });

    const alicilar = await agencyNoticeRecipients(agency.id, null);
    expect(alicilar.indexOf("ortak@ornek.com")).toBeLessThan(
      alicilar.indexOf("calisan@ornek.com")
    );
  });

  it("başka ajansın üyeleri listeye SIZMAZ", async () => {
    const bizim = await createAgency({ email: "biz@ornek.com" });
    const digeri = await createAgency({ email: "onlar@ornek.com" });
    await createMember(digeri.id, { email: "yabanci@ornek.com" });

    const alicilar = await agencyNoticeRecipients(bizim.id, bizim.email);
    expect(alicilar).not.toContain("yabanci@ornek.com");
    expect(alicilar).not.toContain(digeri.email);
  });
});

describe("notifyAgencyTeam", () => {
  const bildirim = {
    event: "approved" as const,
    clientName: "Furkan Teacher",
    postRef: "post-1",
  };

  it("TEK mail gönderir, alıcı olarak ekibin tamamını yazar", async () => {
    const agency = await createAgency({ email: "kurucu@ornek.com" });
    await createMember(agency.id, { email: "davetli@ornek.com" });

    await notifyAgencyTeam(agency.id, { ...bildirim, agencyEmail: agency.email });

    expect(mockNotice).toHaveBeenCalledOnce();
    expect(mockNotice.mock.calls[0][0].to).toEqual([
      "kurucu@ornek.com",
      "davetli@ornek.com",
    ]);
  });

  it("`agencyEmail` verilmese de üyelerden alıcı üretir", async () => {
    const agency = await createAgency({ email: "kurucu@ornek.com" });

    await notifyAgencyTeam(agency.id, bildirim);

    expect(mockNotice.mock.calls[0][0].to).toEqual(["kurucu@ornek.com"]);
  });

  // Bildirim bir YAN ETKİ: onay da, yayın da, cron da buna bağlı değil.
  it("alıcı bulunamazsa throw etmez, sent:false döner", async () => {
    await expect(notifyAgencyTeam("olmayan-ajans", bildirim)).resolves.toEqual({
      sent: false,
      reason: "ajansın bildirim adresi yok",
    });
    expect(mockNotice).not.toHaveBeenCalled();
  });
});
