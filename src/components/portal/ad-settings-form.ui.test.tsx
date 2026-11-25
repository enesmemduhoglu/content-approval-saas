// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { AdSettingsForm, frequencyLabel, gapsFor, modeOf } from "./ad-settings-form";
import { AD_SETTINGS_DEFAULTS, DEFAULT_AD_CAPTION, type AdSettingsView } from "@/lib/portal-ads";

const initial: AdSettingsView = {
  adsEnabled: false,
  adSlot: "21:00",
  adMinGap: 5,
  adMaxGap: 10,
  adCaption: "",
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ok = () => new Response(JSON.stringify({ ads: {} }), { status: 200 });
const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body);
const renderForm = (over: Partial<AdSettingsView> = {}, props: { scheduleSaved?: boolean } = {}) =>
  render(
    <AdSettingsForm
      initial={{ ...initial, ...over }}
      videoSlots={["19:00"]}
      scheduleSaved={props.scheduleSaved ?? true}
    />
  );

describe("sıklık yardımcıları", () => {
  it("min = max sabit mod, sabit kayıt iki sınıra aynı sayıyı yazar", () => {
    expect(modeOf({ adMinGap: 5, adMaxGap: 5 })).toBe("fixed");
    expect(modeOf({ adMinGap: 5, adMaxGap: 10 })).toBe("range");
    expect(gapsFor("fixed", 4, 9)).toEqual({ adMinGap: 4, adMaxGap: 4 });
    expect(gapsFor("range", 4, 9)).toEqual({ adMinGap: 4, adMaxGap: 9 });
    expect(frequencyLabel("fixed", 5, 5)).toBe("Her 5 videoda bir");
    expect(frequencyLabel("range", 5, 10)).toBe("5–10 videoda bir, rastgele");
  });
});

describe("AdSettingsForm", () => {
  it("aralık kaydı: açık, sınırlar, saat ve metin ayar ucuna gider", async () => {
    fetchMock.mockResolvedValue(ok());
    renderForm();
    fireEvent.click(screen.getByRole("switch", { name: "Reklamları yayınla" }));
    fireEvent.change(screen.getByLabelText("Varsayılan reklam metni"), {
      target: { value: "Özel ders için DM!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/portal/ads/settings");
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(sentBody()).toEqual({
      adsEnabled: true,
      adSlot: "21:00",
      adMinGap: 5,
      adMaxGap: 10,
      adCaption: "Özel ders için DM!",
    });
    expect(await screen.findByText("Reklam ayarları kaydedildi.")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("min = max kaydı Sabit olarak açılır; sabit modda tek sayı iki sınıra yazılır", async () => {
    fetchMock.mockResolvedValue(ok());
    renderForm({ adMinGap: 5, adMaxGap: 5 });
    expect(screen.getByRole("tab", { name: "Sabit" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.change(screen.getByLabelText("Kaç videoda bir"), { target: { value: "7" } });
    expect(screen.getByText(/Her 7 videoda bir/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({ adMinGap: 7, adMaxGap: 7 });
  });

  it("Sabit ↔ Aralık geçişi alanları değiştirir", () => {
    renderForm();
    expect(screen.getByLabelText("En az kaç video")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Sabit" }));
    expect(screen.getByLabelText("Kaç videoda bir")).toBeTruthy();
    expect(screen.queryByLabelText("En fazla kaç video")).toBeNull();
  });

  it("aralıkta min > max istek atmadan hata verir", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("En az kaç video"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("En fazla kaç video"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    expect(await screen.findByText("Üst sınır alt sınırdan küçük olamaz")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("açıkken boş metin ve video saatiyle aynı reklam saati istek atmadan reddedilir", async () => {
    renderForm({ adsEnabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    expect(await screen.findByText("Reklam metni boş olamaz")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Varsayılan reklam metni"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Reklam saati"), { target: { value: "19:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    expect(await screen.findByText("Reklam saati video yayın saatlerinden farklı olmalı")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sunucu hatası alanının altında gösterilir", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Geçersiz reklam saati", field: "adSlot" }), { status: 400 })
    );
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    expect(await screen.findByText("Geçersiz reklam saati")).toBeTruthy();
  });

  it("varsayılan metin alana dolu gelir ve değiştirilmezse kayıtta gider (V12c)", async () => {
    fetchMock.mockResolvedValue(ok());
    render(<AdSettingsForm initial={AD_SETTINGS_DEFAULTS} videoSlots={["19:00"]} scheduleSaved />);
    expect((screen.getByLabelText("Varsayılan reklam metni") as HTMLTextAreaElement).value).toBe(
      DEFAULT_AD_CAPTION
    );
    fireEvent.click(screen.getByRole("switch", { name: "Reklamları yayınla" }));
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody().adCaption).toBe(DEFAULT_AD_CAPTION);
  });

  it("reklam saati çipi tek başına (kaldırma düğmesi yok, ortalı sınıf)", () => {
    renderForm();
    expect(screen.getByLabelText("Reklam saati").closest(".p-chip")?.className).toContain("p-chip--solo");
  });

  it("yayın saatleri kaydedilmemişse anahtar kapalı ve neden yazılı", () => {
    renderForm({}, { scheduleSaved: false });
    const toggle = screen.getByRole("switch", { name: "Reklamları yayınla" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/Önce Ayarlar'dan yayın günlerini/)).toBeTruthy();
  });
});
