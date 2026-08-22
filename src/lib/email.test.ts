import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import {
  agencyNoticeSubject,
  approvalEmailSubject,
  renderAgencyNoticeHtml,
  renderAgencyNoticeText,
  renderApprovalEmailHtml,
  renderApprovalEmailText,
  renderRevisedPostEmailHtml,
  renderRevisedPostEmailText,
  revisedPostEmailSubject,
  sendAgencyNoticeEmail,
  sendApprovalRequestEmail,
  sendRevisedPostEmail,
} from "./email";

const input = {
  to: "musteri@ornek.com",
  agencyName: "Parlak Ajans",
  clientName: "Kahve Dükkanı",
  approvalUrl: "https://ornek.com/approve/abc123",
};

beforeEach(() => {
  sendMock.mockReset();
  process.env.RESEND_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

describe("approvalEmailSubject (D8)", () => {
  it("konu satırı ajans adını içerir", () => {
    expect(approvalEmailSubject("Parlak Ajans")).toBe(
      "Parlak Ajans sizin için bir post hazırladı"
    );
  });
});

describe("renderApprovalEmailHtml", () => {
  it("CTA linkini ve müşteri adını içerir", () => {
    const html = renderApprovalEmailHtml(input);
    expect(html).toContain("İncele ve Onayla");
    expect(html).toContain(input.approvalUrl);
    expect(html).toContain("Kahve Dükkanı");
  });

  it("HTML injection'a karşı değerleri escape eder", () => {
    const html = renderApprovalEmailHtml({
      ...input,
      agencyName: '<script>alert("x")</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("gövde HTML'i snapshot ile eşleşir", () => {
    expect(renderApprovalEmailHtml(input)).toMatchSnapshot();
  });

  it("markalama: logo ve marka rengi işlenir (D3.4)", () => {
    const html = renderApprovalEmailHtml({
      ...input,
      logoUrl: "https://ornek.com/logo.png",
      brandColor: "#aa3366",
    });
    expect(html).toContain('src="https://ornek.com/logo.png"');
    expect(html).toContain("background: #aa3366");
  });

  it("markalama: geçersiz renk varsayılan accent'e düşer, HTML'e gömülmez", () => {
    const html = renderApprovalEmailHtml({
      ...input,
      brandColor: "red; } body { display:none",
    });
    expect(html).toContain("background: #1e3a34");
    expect(html).not.toContain("display:none");
  });

  it("markalama yoksa varsayılan görünüm değişmez", () => {
    const html = renderApprovalEmailHtml(input);
    expect(html).not.toContain("<img");
    expect(html).toContain("background: #1e3a34");
  });
});

describe("renderApprovalEmailText", () => {
  it("düz metin alternatifi linki ve ajans adını içerir", () => {
    const text = renderApprovalEmailText(input);
    expect(text).toContain(input.approvalUrl);
    expect(text).toContain("Parlak Ajans");
    expect(text).not.toContain("<");
  });
});

describe("ajans bildirimi", () => {
  const notice = {
    to: "ajans@ornek.com",
    clientName: "Kahve Dükkanı",
    postRef: "dizi/my-bad",
  } as const;

  it("konu satırı olayı, müşteriyi ve postu tek bakışta verir", () => {
    expect(agencyNoticeSubject({ ...notice, event: "request_sent" })).toBe(
      "[Onay bekliyor] Kahve Dükkanı — dizi/my-bad"
    );
    expect(agencyNoticeSubject({ ...notice, event: "approved" })).toBe(
      "[Onaylandı] Kahve Dükkanı — dizi/my-bad"
    );
    expect(agencyNoticeSubject({ ...notice, event: "rejected" })).toBe(
      "[Reddedildi] Kahve Dükkanı — dizi/my-bad"
    );
  });

  it("onay bildirimi yayının AKIBETİNİ söyler, sadece kararı değil", () => {
    const yayinlandi = renderAgencyNoticeText({
      ...notice,
      event: "approved",
      publishStatus: "published",
      igPermalink: "https://www.instagram.com/p/ABC/",
    });
    expect(yayinlandi).toContain("ONAYLADI");
    expect(yayinlandi).toContain("Instagram'a yayınlandı");
    expect(yayinlandi).toContain("https://www.instagram.com/p/ABC/");

    const patladi = renderAgencyNoticeText({
      ...notice,
      event: "approved",
      publishStatus: "failed",
    });
    expect(patladi).toContain("YAYINLANAMADI");
  });

  it("müşteriye mail gitmediyse bunu açıkça yazar ve linki verir", () => {
    const text = renderAgencyNoticeText({
      ...notice,
      event: "request_sent",
      clientEmailSent: false,
      approvalUrl: "https://ornek.com/approve/abc123",
    });
    expect(text).toContain("GİTMEDİ");
    expect(text).toContain("https://ornek.com/approve/abc123");
  });

  it("red bildirimi gerekçeyi taşır", () => {
    expect(
      renderAgencyNoticeText({ ...notice, event: "rejected", rejectionReason: "Logo eski" })
    ).toContain("Logo eski");
    expect(renderAgencyNoticeText({ ...notice, event: "rejected" })).toContain(
      "Gerekçe belirtilmedi"
    );
  });

  it("HTML injection'a karşı escape eder", () => {
    const html = renderAgencyNoticeHtml({
      ...notice,
      clientName: '<script>alert("x")</script>',
      event: "approved",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("gönderim Resend hatasını sessizce yutmaz", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "Geçersiz adres" },
    });
    await expect(
      sendAgencyNoticeEmail({ ...notice, event: "approved" })
    ).resolves.toEqual({ sent: false, reason: "validation_error: Geçersiz adres" });
  });
});

// ------------------------------------------------- revizyon turu (F10)

describe("revizyon bildirimleri", () => {
  const notice = {
    to: "ajans@ornek.com",
    clientName: "Kahve Dükkanı",
    postRef: "dizi/my-bad",
  } as const;

  it("ajans bildirimi 'REDDETTİ' DEMEZ, yapılacak işi söyler", () => {
    const text = renderAgencyNoticeText({
      ...notice,
      event: "revision_requested",
      revisionRequest: "İkinci cümleyi yumuşat",
      revisionRound: 1,
    });
    expect(text).toContain("DÜZELTME istedi");
    expect(text).not.toContain("REDDETTİ");
    expect(text).toContain("İkinci cümleyi yumuşat");
    // Eylem çağrısı olmadan ajans "bu iş bitti" sanabilir.
    expect(text).toContain("Düzeltip tekrar gönder");
  });

  it("konu satırı revizyonu reddetmeden ayırır", () => {
    expect(
      agencyNoticeSubject({ ...notice, event: "revision_requested" })
    ).toBe("[Revizyon istendi] Kahve Dükkanı — dizi/my-bad");
  });

  it("müşteri ne istediğini yazmadıysa ajansa dürüstçe söylenir", () => {
    const text = renderAgencyNoticeText({
      ...notice,
      event: "revision_requested",
      revisionRequest: null,
    });
    expect(text).toContain("Ne istediğini yazmadı");
  });

  it("müşteri bildirimi müşterinin KENDİ isteğini geri okur", () => {
    const revised = {
      ...input,
      revisionRequest: "İkinci cümleyi yumuşat",
      agencyNote: "Yumuşattım",
      round: 2,
    };
    const text = renderRevisedPostEmailText(revised);
    expect(text).toContain("Senin isteğin: İkinci cümleyi yumuşat");
    expect(text).toContain("Ajansın notu: Yumuşattım");
    expect(text).toContain("2. tur");
    expect(text).toContain(input.approvalUrl);
    expect(revisedPostEmailSubject("Parlak Ajans")).toContain("Parlak Ajans");
  });

  it("HTML gövdede müşteri metni kaçırılır (XSS)", () => {
    const html = renderRevisedPostEmailHtml({
      ...input,
      revisionRequest: '<script>alert("x")</script>',
      round: 1,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("gönderim `gonder()` yolundan geçer: Resend { error } yutulmaz", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "Alıcı adresi geçersiz" },
    });
    await expect(sendRevisedPostEmail({ ...input, round: 1 })).resolves.toEqual({
      sent: false,
      reason: "validation_error: Alıcı adresi geçersiz",
    });
  });

  it("başarılı gönderim text+html multipart olur", async () => {
    sendMock.mockResolvedValue({ data: { id: "email-2" }, error: null });
    await expect(sendRevisedPostEmail({ ...input, round: 1 })).resolves.toEqual({
      sent: true,
    });
    const arg = sendMock.mock.calls[0][0];
    expect(arg.to).toBe(input.to);
    expect(arg.html).toContain(input.approvalUrl);
    expect(arg.text).toContain(input.approvalUrl);
  });
});

describe("sendApprovalRequestEmail", () => {
  it("başarılı gönderimde doğru konu ve alıcıyla, text+html multipart çağrılır", async () => {
    sendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
    await expect(sendApprovalRequestEmail(input)).resolves.toEqual({ sent: true });
    expect(sendMock).toHaveBeenCalledOnce();
    const arg = sendMock.mock.calls[0][0];
    expect(arg.to).toBe(input.to);
    expect(arg.subject).toContain("Parlak Ajans");
    expect(arg.html).toContain("İncele ve Onayla");
    expect(arg.text).toContain(input.approvalUrl);
  });

  // resend@4 API hatalarında throw ETMEZ, { data: null, error } döndürür.
  // Bu dönüş okunmadığı sürece reddedilen gönderim iz bırakmadan kaybolur —
  // 17.08'de iki gün boyunca onay maili gitmemesinin sebebi buydu.
  it("Resend { error } döndürdüğünde bunu sent:false olarak bildirir", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "Alıcı adresi geçersiz" },
    });
    await expect(sendApprovalRequestEmail(input)).resolves.toEqual({
      sent: false,
      reason: "validation_error: Alıcı adresi geçersiz",
    });
  });

  it("Resend hatası akışı DURDURMAZ — asla throw etmez (fire-and-forget)", async () => {
    sendMock.mockRejectedValue(new Error("Resend down"));
    await expect(sendApprovalRequestEmail(input)).resolves.toEqual({
      sent: false,
      reason: "Resend down",
    });
  });

  it("API key yoksa gönderim atlanır, hata fırlatılmaz", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendApprovalRequestEmail(input)).resolves.toEqual({
      sent: false,
      reason: "RESEND_API_KEY tanımlı değil",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
