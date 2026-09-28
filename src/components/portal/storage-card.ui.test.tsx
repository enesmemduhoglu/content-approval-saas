// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StorageCard } from "./storage-card";
import { storageView } from "@/lib/storage-usage";

afterEach(() => cleanup());

const GB = 1000 ** 3;
const usage = (totalBytes: number) => ({
  totalBytes,
  videoBytes: 1.4 * GB,
  videoCount: 19,
  frameBytes: 3_000_000,
});

describe("StorageCard", () => {
  it("hazır: değer, çubuk ve kalan video satırı", () => {
    render(<StorageCard state={{ kind: "ready", view: storageView(usage(1.4 * GB)) }} />);
    expect(screen.getByRole("heading", { name: "DEPOLAMA" })).toBeTruthy();
    expect(screen.getByText("1,4 GB")).toBeTruthy();
    expect(screen.getByText("/ 10 GB")).toBeTruthy();
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("14");
    expect(meter.className).not.toContain("p-storage--");
    expect(screen.getByText(/^Yaklaşık \d+ video daha sığar$/)).toBeTruthy();
  });

  it("%80 üstü uyarı tonu, dolu olunca tehlike tonu", () => {
    const { rerender } = render(
      <StorageCard state={{ kind: "ready", view: storageView(usage(8.6 * GB)) }} />
    );
    expect(screen.getByRole("meter").className).toContain("p-storage--warn");
    expect(screen.getByText(/^Yer azalıyor/)).toBeTruthy();

    rerender(<StorageCard state={{ kind: "ready", view: storageView(usage(10.2 * GB)) }} />);
    expect(screen.getByRole("meter").className).toContain("p-storage--full");
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("Yer doldu. Kuyruk dışındaki videoları silebilirsin.")).toBeTruthy();
  });

  it("okunamadı: kart kalır, sayı yerine açıklama", () => {
    render(<StorageCard state={{ kind: "failed" }} />);
    expect(screen.getByRole("heading", { name: "DEPOLAMA" })).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText("Şu an okunamadı. Biraz sonra yeniden dene.")).toBeTruthy();
  });

  it("yükleniyor: iskelet, sayı yok", () => {
    render(<StorageCard state={{ kind: "loading" }} />);
    expect(screen.getByLabelText("Depolama yükleniyor").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("meter")).toBeNull();
  });
});
