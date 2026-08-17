// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EmailBadge, PublishBadge } from "./status-badge";

afterEach(cleanup);

describe("PublishBadge", () => {
  it("onaylanmış ama yayınlanmamış post panelde görünür olur", async () => {
    const { container } = render(
      <PublishBadge status="idle" awaitingPublish />
    );
    expect(screen.getByText("Yayınlanmadı")).toBeTruthy();
    expect(container.querySelector(".publish-idle")).toBeTruthy();
  });

  it("yayın hedefi olmayan 'idle' post hiçbir rozet göstermez", async () => {
    const { container } = render(<PublishBadge status="idle" />);
    expect(container.innerHTML).toBe("");
  });

  it("Instagram bağlı değilken ('skipped') rozet çıkmaz", async () => {
    const { container } = render(<PublishBadge status="skipped" awaitingPublish />);
    expect(container.innerHTML).toBe("");
  });

  it("mükerrer yayın engellenmiş postu 'Zaten yayında' diye işaretler", async () => {
    const { container } = render(<PublishBadge status="duplicate" />);
    expect(screen.getByText("Zaten yayında")).toBeTruthy();
    expect(container.querySelector(".publish-duplicate")).toBeTruthy();
    // Hata değil: "Yayınlanamadı" rozetiyle karıştırılmamalı.
    expect(screen.queryByText("Yayınlanamadı")).toBeNull();
  });
});

describe("EmailBadge", () => {
  it("mail gitmediyse göze batan rozet çıkar", () => {
    const { container } = render(<EmailBadge sent={false} />);
    expect(screen.getByText("Mail GİTMEDİ")).toBeTruthy();
    expect(container.querySelector(".email-failed")).toBeTruthy();
  });

  it("mail gittiyse de rozet çıkar — sessiz kalmak sorunu çözmezdi", () => {
    const { container } = render(<EmailBadge sent />);
    expect(screen.getByText("Mail gitti")).toBeTruthy();
    expect(container.querySelector(".email-sent")).toBeTruthy();
  });

  it("bilinmiyorsa (null) hiçbir şey uydurmaz", () => {
    const { container } = render(<EmailBadge sent={null} />);
    expect(container.innerHTML).toBe("");
  });
});
