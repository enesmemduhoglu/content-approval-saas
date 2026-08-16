// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PublishBadge } from "./status-badge";

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
});
