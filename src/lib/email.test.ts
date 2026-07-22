import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import {
  approvalEmailSubject,
  renderApprovalEmailHtml,
  renderApprovalEmailText,
  sendApprovalRequestEmail,
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
});

describe("renderApprovalEmailText", () => {
  it("düz metin alternatifi linki ve ajans adını içerir", () => {
    const text = renderApprovalEmailText(input);
    expect(text).toContain(input.approvalUrl);
    expect(text).toContain("Parlak Ajans");
    expect(text).not.toContain("<");
  });
});

describe("sendApprovalRequestEmail", () => {
  it("başarılı gönderimde doğru konu ve alıcıyla, text+html multipart çağrılır", async () => {
    sendMock.mockResolvedValue({ id: "email-1" });
    await sendApprovalRequestEmail(input);
    expect(sendMock).toHaveBeenCalledOnce();
    const arg = sendMock.mock.calls[0][0];
    expect(arg.to).toBe(input.to);
    expect(arg.subject).toContain("Parlak Ajans");
    expect(arg.html).toContain("İncele ve Onayla");
    expect(arg.text).toContain(input.approvalUrl);
  });

  it("Resend hatası akışı DURDURMAZ — asla throw etmez (fire-and-forget)", async () => {
    sendMock.mockRejectedValue(new Error("Resend down"));
    await expect(sendApprovalRequestEmail(input)).resolves.toBeUndefined();
  });

  it("API key yoksa gönderim atlanır, hata fırlatılmaz", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendApprovalRequestEmail(input)).resolves.toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
