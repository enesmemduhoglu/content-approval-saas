// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apply = vi.fn(() => true);
let waiting = false;
vi.mock("@/components/portal/sw-register", () => ({
  SW_UPDATE_EVENT: "portal:sw-guncelleme",
  applyServiceWorkerUpdate: () => apply(),
  hasWaitingServiceWorker: () => waiting,
}));

import { UpdateBand } from "./update-band";

beforeEach(() => {
  apply.mockClear();
  waiting = false;
});

afterEach(() => cleanup());

describe("UpdateBand — yeni sürüm bandı", () => {
  it("olay gelmeden görünmez; SW_UPDATE_EVENT gelince çıkar", () => {
    render(<UpdateBand />);
    expect(screen.queryByText("Yeni sürüm hazır")).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("portal:sw-guncelleme"));
    });
    expect(screen.getByText("Yeni sürüm hazır")).toBeTruthy();
  });

  it("Yenile → applyServiceWorkerUpdate (skipWaiting yalnızca dokununca)", () => {
    waiting = true;
    render(<UpdateBand />);
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yenile" }));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("takıldığında zaten bekleyen sürüm varsa bant hemen görünür", () => {
    waiting = true;
    render(<UpdateBand />);
    expect(screen.getByText("Yeni sürüm hazır")).toBeTruthy();
  });

  it("'Şimdi değil' bandı kapatır, SW'ye dokunmaz", () => {
    waiting = true;
    render(<UpdateBand />);
    fireEvent.click(screen.getByRole("button", { name: "Şimdi değil" }));
    expect(screen.queryByText("Yeni sürüm hazır")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});
