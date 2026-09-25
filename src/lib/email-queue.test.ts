import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendRawEmail: vi.fn() };
});

import { sendRawEmail } from "@/lib/email";
import {
  captionHead,
  portalUrl,
  queueDigestSubject,
  queueRecipient,
  renderQueueDigest,
  renderQueueFailed,
  renderQueuePublished,
  renderSlotEmpty,
  safeReason,
  sendQueuePublishedEmail,
  slotEmptySubject,
} from "./email-queue";

const mockRaw = vi.mocked(sendRawEmail);

beforeEach(() => {
  vi.clearAllMocks();
  mockRaw.mockResolvedValue({ sent: true });
});

describe("yardımcılar", () => {
  it("alıcı: notifyEmail varsa o, yoksa müşteri adresi", () => {
    expect(queueRecipient({ notifyEmail: "a@x.test" }, "c@x.test")).toBe("a@x.test");
    expect(queueRecipient({ notifyEmail: "  " }, "c@x.test")).toBe("c@x.test");
    expect(queueRecipient(null, "c@x.test")).toBe("c@x.test");
  });

  it("portal linki APP_URL'den; yoksa link yok", () => {
    vi.stubEnv("APP_URL", "https://app.example/");
    expect(portalUrl()).toBe("https://app.example/portal");
    vi.stubEnv("APP_URL", "");
    expect(portalUrl()).toBeNull();
  });

  it("caption başı: ilk satır, uzunsa kırpılır", () => {
    expect(captionHead("Başlık\n#etiket")).toBe("Başlık");
    expect(captionHead("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("safeReason: sorgulu URL'leri ve token kalıplarını ayıklar", () => {
    const reason = safeReason(
      "İndirilemedi https://r2.example/v.mp4?X-Amz-Signature=abc&X-Amz-Credential=k " +
        "access_token=IGAAgizli · fbtrace_id=Axyz"
    );
    expect(reason).not.toContain("abc");
    expect(reason).not.toContain("IGAAgizli");
    expect(reason).toContain("fbtrace_id=Axyz");
    expect(safeReason(null)).toBe("Bilinmeyen hata");
    expect(safeReason("x".repeat(1000))).toHaveLength(300);
  });
});

describe("şablonlar", () => {
  it("başarı: permalink ve caption başı; HTML kaçışlı", () => {
    const { text, html } = renderQueuePublished({
      to: "c@x.test",
      clientName: "<Furkan>",
      caption: "Deyim <b>günü</b>\n#tag",
      igPermalink: "https://instagram.com/reel/A/",
    });
    expect(text).toContain("https://instagram.com/reel/A/");
    expect(text).toContain("Deyim <b>günü</b>");
    expect(html).not.toContain("<b>günü</b>");
    expect(html).toContain("&lt;Furkan&gt;");
  });

  it("hata: neden sırsız, portal linki var", () => {
    const { text } = renderQueueFailed({
      to: "c@x.test",
      clientName: "Furkan",
      caption: "Video",
      reason: "Hata access_token=IGAAgizli",
      portalUrl: "https://app.example/portal",
    });
    expect(text).not.toContain("IGAAgizli");
    expect(text).toContain("https://app.example/portal");
    expect(text).toContain("sıradaki video");
  });

  it("slot boş: üç neden, üç ayrı konu ve metin; yerel saat", () => {
    const base = {
      to: "c@x.test",
      clientName: "Furkan",
      slotAt: new Date("2026-09-25T16:00:00Z"),
      timezone: "Europe/Istanbul",
      portalUrl: null,
    };
    expect(slotEmptySubject({ reason: "no_approved" })).toMatch(/onaylı video yoktu/);
    expect(slotEmptySubject({ reason: "empty" })).toMatch(/video kalmadı/);
    expect(slotEmptySubject({ reason: "blocked" })).toMatch(/Instagram/);

    const noApproved = renderSlotEmpty({ ...base, reason: "no_approved", pendingCount: 3 }).text;
    expect(noApproved).toContain("19:00");
    expect(noApproved).toContain("3 video onayını bekliyor");

    const blocked = renderSlotEmpty({
      ...base,
      reason: "blocked",
      detail: "Instagram hesabı bağlı değil",
    }).text;
    expect(blocked).toContain("Instagram hesabı bağlı değil");
    expect(blocked).toContain("kuyrukta yerinde");
  });

  it("günlük özet: yarının yayınları yerel saatle, kapak görseli, bekleyen sayısı", () => {
    const input = {
      to: "c@x.test",
      clientName: "Furkan",
      timezone: "Europe/Istanbul",
      pendingCount: 2,
      upcoming: [
        {
          slotAt: new Date("2026-09-26T16:00:00Z"),
          caption: "Yarının videosu\n#tag",
          coverUrl: "https://r2.example/f.jpg?X-Amz-Signature=s",
        },
      ],
      portalUrl: "https://app.example/portal",
    };
    const { text, html } = renderQueueDigest(input);
    expect(text).toContain("Yarın 19:00: “Yarının videosu”");
    expect(text).toContain("2 video onayını bekliyor");
    expect(html).toContain('<img src="https://r2.example/f.jpg?X-Amz-Signature=s"');
    expect(queueDigestSubject(input)).toBe("Yarın 1 video yayınlanacak");
    expect(queueDigestSubject({ upcoming: [], pendingCount: 4 })).toBe("4 video onayını bekliyor");
  });

  it("günlük özet: yarın onaylı video yoksa bunu açıkça söyler", () => {
    const { text } = renderQueueDigest({
      to: "c@x.test",
      clientName: "Furkan",
      timezone: "Europe/Istanbul",
      pendingCount: 1,
      upcoming: [],
      portalUrl: null,
    });
    expect(text).toContain("yarın yayın yapılmayacak");
  });
});

describe("gönderim", () => {
  it("gonder() kapısından (sendRawEmail) gider ve sonucunu döner", async () => {
    mockRaw.mockResolvedValue({ sent: false, reason: "RESEND_API_KEY tanımlı değil" });
    const result = await sendQueuePublishedEmail({
      to: "c@x.test",
      clientName: "Furkan",
      caption: "Video",
      igPermalink: null,
    });
    expect(result).toEqual({ sent: false, reason: "RESEND_API_KEY tanımlı değil" });
    expect(mockRaw).toHaveBeenCalledWith(
      expect.objectContaining({ to: "c@x.test", subject: "Videon Instagram'da yayınlandı" }),
      "kuyruk yayını başarılı"
    );
  });
});
