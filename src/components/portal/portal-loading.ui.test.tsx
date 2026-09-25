// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let pathname = "/portal";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

import { PortalLoading } from "./portal-loading";

afterEach(() => cleanup());

describe("PortalLoading — sekme geçişinde anında iskelet", () => {
  it.each([
    ["/portal", "Kuyruk"],
    ["/portal/yukle", "Yükle"],
    ["/portal/gecmis", "Geçmiş"],
    ["/portal/ayarlar", "Ayarlar"],
  ])("%s: gelecek sayfanın başlığı ve aktif sekmesiyle açılır", (path, title) => {
    pathname = path;
    render(<PortalLoading />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
    const current = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.textContent)).toEqual([title]);
  });

  it("video detayında sekme çubuğu çizilmez — detayın kendi eylem çubuğu var", () => {
    pathname = "/portal/video/abc";
    render(<PortalLoading />);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("ekran okuyucuya yüklendiğini söyler", () => {
    pathname = "/portal/gecmis";
    render(<PortalLoading />);
    expect(screen.getByRole("status").textContent).toBe("Yükleniyor…");
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
  });
});
