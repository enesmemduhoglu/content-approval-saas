// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { SettingsForm, type SettingsValue } from "./settings-form";

const initial: SettingsValue = {
  slots: ["19:00"],
  days: [1, 2, 3, 4, 5, 6, 7],
  timezone: "Europe/Istanbul",
  requireApproval: true,
  paused: false,
  notifyEmail: null,
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Onay anahtarı: `role="switch"`, durumu `aria-checked`'te. */
function approvalSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "Yayından önce onay iste" });
}

const isOn = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";

describe("SettingsForm — onayı kapatırken uyarı", () => {
  it("anahtar kapatılınca onay HEMEN kapanmaz; önce uyarı çıkar", () => {
    render(<SettingsForm initial={initial} defaultNotifyEmail="musteri@ornek.com" />);
    fireEvent.click(approvalSwitch());

    expect(screen.getByRole("alertdialog", { name: "Onayı kapatma uyarısı" })).toBeTruthy();
    expect(isOn(approvalSwitch())).toBe(true);
    // Uyarı açıkken kaydetme kapalı: yarım kalmış bir kararla ayar yazılmasın.
    expect((screen.getByRole("button", { name: "Kaydet" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("'Vazgeç' onayı açık bırakır", () => {
    render(<SettingsForm initial={initial} defaultNotifyEmail={null} />);
    fireEvent.click(approvalSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Vazgeç" }));
    expect(isOn(approvalSwitch())).toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("'Anladım' sonrası kayıt requireApproval: false gönderir", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ settings: { ...initial, requireApproval: false } }), { status: 200 })
    );
    render(<SettingsForm initial={initial} defaultNotifyEmail={null} />);
    fireEvent.click(approvalSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Anladım, onayı kapat" }));
    expect(isOn(approvalSwitch())).toBe(false);
    expect(screen.getByText(/Onay kapalı: videolar sırası gelince/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toMatchObject({ requireApproval: false, slots: ["19:00"] });
    expect(await screen.findByText("Ayarlar kaydedildi.")).toBeTruthy();
  });

  it("en fazla 6 saat eklenebilir, tek saat kaldırılamaz", () => {
    render(<SettingsForm initial={initial} defaultNotifyEmail={null} />);
    expect(
      (screen.getByRole("button", { name: "19:00 saatini kaldır" }) as HTMLButtonElement).disabled
    ).toBe(true);
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole("button", { name: /Saat ekle/ }));
    expect(screen.getAllByLabelText(/yayın saati/)).toHaveLength(6);
    expect(screen.queryByRole("button", { name: /Saat ekle/ })).toBeNull();
    // Eklenen saatlerin hepsi "12:00": özet tekrarı bir kez sayar — tick de
    // aynı saati günde bir kez işler (sunucu tekrarı kayıtta zaten reddeder).
    expect(screen.getByText("Her gün 2 video · 12:00, 19:00")).toBeTruthy();
  });

  it("sunucunun alan hatası saatlerin altında gösterilir", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Aynı saat iki kez seçilemez", field: "slots" }), {
        status: 400,
      })
    );
    render(<SettingsForm initial={initial} defaultNotifyEmail={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    expect(await screen.findByText("Aynı saat iki kez seçilemez")).toBeTruthy();
  });

  it("duraklat anahtarı kayıtta paused: true gönderir", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ settings: { ...initial, paused: true } }), { status: 200 })
    );
    render(<SettingsForm initial={initial} defaultNotifyEmail={null} />);
    const pause = screen.getByRole("switch", { name: "Yayını duraklat" });
    expect(isOn(pause)).toBe(false);
    fireEvent.click(pause);
    expect(isOn(pause)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ paused: true });
  });
});

describe("SettingsForm — yayın günleri (V8)", () => {
  const dayButton = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const pressed = (el: HTMLElement) => el.getAttribute("aria-pressed") === "true";
  const pressedDays = () =>
    within(screen.getByRole("group", { name: "Yayın günleri" }))
      .getAllByRole("button")
      .filter(pressed)
      .map((b) => b.textContent);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("7 gün çipi grupta; çipe dokunmak seçimi açıp kapatır", () => {
    render(<SettingsForm initial={{ ...initial, days: [1, 4, 5] }} defaultNotifyEmail={null} />);
    const group = screen.getByRole("group", { name: "Yayın günleri" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz",
    ]);
    expect(pressedDays()).toEqual(["Pzt", "Per", "Cum"]);
    expect(screen.getByText("Haftada 3 gün")).toBeTruthy();

    fireEvent.click(dayButton("Salı"));
    expect(pressed(dayButton("Salı"))).toBe(true);
    fireEvent.click(dayButton("Perşembe"));
    expect(pressed(dayButton("Perşembe"))).toBe(false);
    expect(pressedDays()).toEqual(["Pzt", "Sal", "Cum"]);
  });

  it("hazır seçimler: Hafta içi / Hafta sonu / Her gün; eşleşen hazır seçim basılı görünür", () => {
    render(<SettingsForm initial={{ ...initial, days: [1, 4] }} defaultNotifyEmail={null} />);
    const preset = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(["Her gün", "Hafta içi", "Hafta sonu"].some((n) => pressed(preset(n)))).toBe(false);

    fireEvent.click(preset("Hafta içi"));
    expect(pressedDays()).toEqual(["Pzt", "Sal", "Çar", "Per", "Cum"]);
    expect(pressed(preset("Hafta içi"))).toBe(true);

    fireEvent.click(preset("Hafta sonu"));
    expect(pressedDays()).toEqual(["Cmt", "Paz"]);

    fireEvent.click(preset("Her gün"));
    expect(pressedDays()).toHaveLength(7);
    expect(pressed(preset("Her gün"))).toBe(true);
  });

  it("son seçili gün kaldırılamaz: çip kapanmaz, 'Yayını duraklat' notu çıkar", () => {
    render(<SettingsForm initial={{ ...initial, days: [1] }} defaultNotifyEmail={null} />);
    fireEvent.click(dayButton("Pazartesi"));
    expect(pressed(dayButton("Pazartesi"))).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/En az bir gün seç.*Yayını duraklat/);

    // Başka bir gün seçilince not kalkar.
    fireEvent.click(dayButton("Cuma"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(pressedDays()).toEqual(["Pzt", "Cum"]);
  });

  it("özet kaydedilmemiş seçimle canlı: başlık ve sıradaki 3 yayın zamanı", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T09:00:00Z")); // Cumartesi 12:00, İstanbul
    render(<SettingsForm initial={{ ...initial, days: [1, 4, 5] }} defaultNotifyEmail={null} />);

    expect(screen.getByText("Haftada 3 video · Pzt, Per, Cum · 19:00")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Sıradaki yayınlar" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Pazartesi · 28 Eyl · 19:00",
      "Perşembe · 1 Eki · 19:00",
      "Cuma · 2 Eki · 19:00",
    ]);

    // Kaydetmeden gün değiştir: liste hemen kayar.
    fireEvent.click(screen.getByRole("button", { name: "Hafta sonu" }));
    expect(screen.getByText("Haftada 2 video · Hafta sonu · 19:00")).toBeTruthy();
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Cumartesi · 26 Eyl · 19:00",
      "Pazar · 27 Eyl · 19:00",
      "Cumartesi · 3 Eki · 19:00",
    ]);
  });

  it("kayıt seçili günleri sıralı gönderir; sunucunun alan hatası günlerin altında", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Aynı gün iki kez seçilemez", field: "days" }), { status: 400 })
    );
    render(<SettingsForm initial={{ ...initial, days: [5] }} defaultNotifyEmail={null} />);
    fireEvent.click(dayButton("Pazartesi"));
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ days: [1, 5] });
    expect(await screen.findByText("Aynı gün iki kez seçilemez")).toBeTruthy();
  });
});
