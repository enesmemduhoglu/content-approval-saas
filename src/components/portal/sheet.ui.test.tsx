// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SWIPE_CLOSE_PX, Sheet } from "./sheet";

// jsdom `scrollTo`yu uygulamıyor; kilit kapanışta çağırıyor.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderSheet(props: { busy?: boolean } = {}) {
  const onClose = vi.fn();
  render(
    <Sheet titleId="t" title="Başlık" busy={props.busy} onClose={onClose}>
      <textarea aria-label="Metin" />
      <p>İçerik</p>
    </Sheet>
  );
  return onClose;
}

/** Parmakla `from`dan `to`ya kaydırır; `ms` süresince. */
function swipe(el: Element, from: number, to: number, ms = 300) {
  fireEvent.touchStart(el, { touches: [{ clientY: from }] });
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  fireEvent.touchMove(el, { touches: [{ clientY: to }] });
  fireEvent.touchEnd(el, { touches: [] });
  act(() => {
    vi.advanceTimersByTime(300); // kapanış animasyonu
  });
}

describe("Sheet — kapatma yolları", () => {
  it("arka plana dokunmak kapatır", () => {
    const onClose = renderSheet();
    fireEvent.click(screen.getByTestId("sheet-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sağ üstteki kapat düğmesi kapatır", () => {
    const onClose = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Kapat" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape kapatır", () => {
    const onClose = renderSheet();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("başlıktan yeterince aşağı kaydırmak kapatır", () => {
    const onClose = renderSheet();
    swipe(screen.getByRole("heading", { name: "Başlık" }), 100, 100 + SWIPE_CLOSE_PX + 10);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("içerik en üstteyken içerikten aşağı kaydırmak da kapatır", () => {
    const onClose = renderSheet();
    swipe(screen.getByText("İçerik"), 300, 300 + SWIPE_CLOSE_PX + 10);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("kısa ve yavaş kaydırma kapatmaz, sayfa yerine döner", () => {
    const onClose = renderSheet();
    swipe(screen.getByRole("heading", { name: "Başlık" }), 100, 150, 800);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("dialog") as HTMLElement).style.transform).toBe("");
  });

  it("kısa ama hızlı fiske kapatır", () => {
    const onClose = renderSheet();
    swipe(screen.getByRole("heading", { name: "Başlık" }), 100, 160, 50);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("yazı alanında kaydırmak kapatmaz (metin seçimi/kaydırması)", () => {
    const onClose = renderSheet();
    swipe(screen.getByLabelText("Metin"), 100, 400);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("içerik aşağı kaydırılmışken içerikten çekmek kapatmaz, başlıktan çekmek kapatır", () => {
    const onClose = renderSheet();
    const dialog = screen.getByRole("dialog");
    Object.defineProperty(dialog, "scrollTop", { value: 120, configurable: true });
    swipe(screen.getByText("İçerik"), 300, 600);
    expect(onClose).not.toHaveBeenCalled();
    swipe(screen.getByRole("heading", { name: "Başlık" }), 100, 400);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("işlem sürerken (busy) hiçbir yol kapatmaz", () => {
    const onClose = renderSheet({ busy: true });
    fireEvent.click(screen.getByTestId("sheet-backdrop"));
    fireEvent.keyDown(document, { key: "Escape" });
    swipe(screen.getByRole("heading", { name: "Başlık" }), 100, 400);
    expect((screen.getByRole("button", { name: "Kapat" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("açıkken arka sayfa kilitli, kapanınca serbest", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Sheet titleId="t" title="Başlık" onClose={onClose}>
        <p>x</p>
      </Sheet>
    );
    expect(document.body.style.position).toBe("fixed");
    unmount();
    expect(document.body.style.position).toBe("");
  });
});
