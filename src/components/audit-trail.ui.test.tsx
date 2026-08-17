// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AuditTrail } from "./audit-trail";

afterEach(cleanup);

const entry = (overrides: Partial<Parameters<typeof AuditTrail>[0]["entries"][0]> = {}) => ({
  id: "a1",
  action: "approved",
  ip: "203.0.113.7",
  createdAt: new Date("2026-08-17T14:32:00.000Z"),
  ...overrides,
});

describe("AuditTrail", () => {
  it("kaydı yoksa hiçbir şey göstermez", () => {
    const { container } = render(<AuditTrail entries={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("kararı, zamanı ve IP'yi gösterir", () => {
    render(<AuditTrail entries={[entry()]} />);
    expect(screen.getByText("Müşteri onayladı")).toBeTruthy();
    expect(screen.getByText(/203\.0\.113\.7/)).toBeTruthy();
  });

  it("IP bilinmiyorsa 'unknown' YAZMAZ — sessiz kalmak daha dürüst", () => {
    const { container } = render(<AuditTrail entries={[entry({ ip: "unknown" })]} />);
    expect(container.textContent).not.toContain("unknown");
    expect(screen.getByText("Müşteri onayladı")).toBeTruthy();
  });

  it("reddetmeyi de etiketler ve kayıt sayısını başlıkta verir", () => {
    render(
      <AuditTrail entries={[entry(), entry({ id: "a2", action: "rejected" })]} />
    );
    expect(screen.getByText("Müşteri reddetti")).toBeTruthy();
    expect(screen.getByText("Karar geçmişi (2)")).toBeTruthy();
  });
});
