// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RevisionTrail, type RevisionEntry } from "./revision-trail";

afterEach(cleanup);

const entry = (overrides: Partial<RevisionEntry> = {}): RevisionEntry => ({
  id: "r1",
  round: 1,
  actor: "client",
  event: "revision_requested",
  message: "İkinci cümleyi yumuşat",
  caption: "İlk metin",
  createdAt: new Date("2026-08-22T10:00:00.000Z"),
  ...overrides,
});

describe("RevisionTrail", () => {
  it("kaydı yoksa hiçbir şey göstermez", () => {
    const { container } = render(<RevisionTrail entries={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("müşteri isteğini ve o anki metni gösterir", () => {
    render(<RevisionTrail entries={[entry()]} />);
    expect(screen.getByText("Müşteri düzeltme istedi")).toBeTruthy();
    expect(screen.getByText("İkinci cümleyi yumuşat")).toBeTruthy();
    expect(screen.getByText("İlk metin")).toBeTruthy();
  });

  it("tur sayısı yalnızca MÜŞTERİ satırlarından sayılır", () => {
    render(
      <RevisionTrail
        entries={[
          entry(),
          entry({ id: "r2", actor: "agency", event: "resubmitted", caption: "Yeni metin" }),
        ]}
      />
    );
    // 2 kayıt ama 1 tur: ajansın cevabı aynı turun ikinci yarısı.
    expect(screen.getByText("Revizyon geçmişi (1 tur · 2 kayıt)")).toBeTruthy();
    expect(screen.getByText("Ajans düzeltip tekrar gönderdi")).toBeTruthy();
  });

  it("mesaj yoksa 'belirtilmedi' gibi bir doldurma metni YAZMAZ", () => {
    const { container } = render(<RevisionTrail entries={[entry({ message: null })]} />);
    expect(container.querySelector(".revision-message")).toBeNull();
  });

  it("son söz müşterideyse liste açık gelir — ajansın yapacak işi var", () => {
    const { container } = render(<RevisionTrail entries={[entry()]} />);
    expect(container.querySelector("details.revision-trail")?.hasAttribute("open")).toBe(
      true
    );
  });

  it("son söz ajanstaysa liste katlı gelir", () => {
    const { container } = render(
      <RevisionTrail
        entries={[entry(), entry({ id: "r2", actor: "agency", event: "resubmitted" })]}
      />
    );
    expect(container.querySelector("details.revision-trail")?.hasAttribute("open")).toBe(
      false
    );
  });
});
