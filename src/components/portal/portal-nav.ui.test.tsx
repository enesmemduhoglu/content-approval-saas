// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

let pathname = "/portal";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

import { PortalTabBar, isActiveTab } from "./portal-nav";

afterEach(() => cleanup());

function tabs() {
  return within(screen.getByRole("navigation", { name: "Ana gezinme" })).getAllByRole("link");
}

describe("PortalTabBar — alt sekme çubuğu", () => {
  it("dört sekme, doğru adreslerle ve sırayla", () => {
    render(<PortalTabBar />);
    expect(tabs().map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Kuyruk", "/portal"],
      ["Yükle", "/portal/yukle"],
      ["Geçmiş", "/portal/gecmis"],
      ["Ayarlar", "/portal/ayarlar"],
    ]);
  });

  it("aktif sekme aria-current=page taşır, diğerleri taşımaz", () => {
    pathname = "/portal/gecmis";
    render(<PortalTabBar />);
    const current = tabs().filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.textContent)).toEqual(["Geçmiş"]);
  });

  it("Kuyruk sekmesi yalnızca /portal'da aktif — alt sayfalarda değil", () => {
    expect(isActiveTab("/portal", "/portal")).toBe(true);
    expect(isActiveTab("/portal", "/portal/ayarlar")).toBe(false);
    expect(isActiveTab("/portal/ayarlar", "/portal/ayarlar")).toBe(true);
    // Önek tuzağı: "/portal/yukleme" gibi bir yol Yükle sekmesini yakmamalı.
    expect(isActiveTab("/portal/yukle", "/portal/yuklemeler")).toBe(false);
    expect(isActiveTab("/portal/yukle", null)).toBe(false);
  });
});
