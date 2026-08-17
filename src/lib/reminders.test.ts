import { describe, expect, it } from "vitest";
import {
  REMINDER_AFTER_DAYS,
  daysPending,
  reminderDecision,
  type ReminderCandidate,
} from "./reminders";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const gunOnce = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const gunSonra = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

function post(overrides: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    status: "pending",
    createdAt: gunOnce(REMINDER_AFTER_DAYS),
    reminderSentAt: null,
    expiryNoticeSentAt: null,
    linkExpiresAt: gunSonra(5),
    ...overrides,
  };
}

describe("daysPending", () => {
  it("tam günü aşağı yuvarlar", () => {
    expect(daysPending(gunOnce(3), NOW)).toBe(3);
    // 2 gün 23 saat henüz 3 gün değil.
    expect(daysPending(new Date(gunOnce(3).getTime() + 3600_000), NOW)).toBe(2);
  });
});

describe("müşteri hatırlatması", () => {
  it("eşiğe gelen, linki geçerli, hiç hatırlatılmamış post hatırlatılır", () => {
    expect(reminderDecision(post(), NOW)).toBe("client_reminder");
  });

  it("eşiğin altındaki post rahat bırakılır", () => {
    expect(reminderDecision(post({ createdAt: gunOnce(REMINDER_AFTER_DAYS - 1) }), NOW)).toBe(
      "none"
    );
  });

  it("bir kez hatırlatılan posta İKİNCİ kez gitmez (spam koruması)", () => {
    expect(reminderDecision(post({ reminderSentAt: gunOnce(1) }), NOW)).toBe("none");
  });

  it("çok eski post da yalnızca bir kez hatırlatılır", () => {
    expect(reminderDecision(post({ createdAt: gunOnce(30) }), NOW)).toBe("client_reminder");
    expect(
      reminderDecision(post({ createdAt: gunOnce(30), reminderSentAt: gunOnce(28) }), NOW)
    ).toBe("none");
  });
});

describe("karar verilmiş postlar", () => {
  it.each(["approved", "rejected", "draft"])("%s postta hiçbir şey yapılmaz", (status) => {
    expect(reminderDecision(post({ status }), NOW)).toBe("none");
  });

  it("linki ölmüş olsa bile karar verilmişse sessiz kalınır", () => {
    expect(reminderDecision(post({ status: "approved", linkExpiresAt: gunOnce(1) }), NOW)).toBe(
      "none"
    );
  });
});

describe("süresi dolmuş link", () => {
  it("müşteriye DEĞİL ajansa bildirilir — müşterinin elindeki link çalışmıyor", () => {
    expect(reminderDecision(post({ linkExpiresAt: gunOnce(1) }), NOW)).toBe(
      "agency_expiry_notice"
    );
  });

  it("link ölmüşse müşteri hatırlatması hiç denenmez (hatırlatılmamış olsa bile)", () => {
    const karar = reminderDecision(
      post({ linkExpiresAt: gunOnce(1), createdAt: gunOnce(10), reminderSentAt: null }),
      NOW
    );
    expect(karar).not.toBe("client_reminder");
  });

  it("ajansa bir kez bildirilir, ertesi gece tekrar etmez", () => {
    expect(
      reminderDecision(
        post({ linkExpiresAt: gunOnce(1), expiryNoticeSentAt: gunOnce(1) }),
        NOW
      )
    ).toBe("none");
  });

  it("linki HİÇ olmayan post da ajansa bildirilir", () => {
    expect(reminderDecision(post({ linkExpiresAt: null }), NOW)).toBe("agency_expiry_notice");
  });

  it("tam bitiş anında link ölü sayılır (sınır)", () => {
    expect(reminderDecision(post({ linkExpiresAt: NOW }), NOW)).toBe("agency_expiry_notice");
  });
});
