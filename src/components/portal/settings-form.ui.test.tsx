// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { SettingsForm, type SettingsValue } from "./settings-form";

const initial: SettingsValue = {
  slots: ["19:00"],
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

function approvalBox(): HTMLInputElement {
  return screen.getByRole("checkbox", { name: "Yayından önce onayım gereksin" }) as HTMLInputElement;
}

describe("SettingsForm — onayı kapatırken uyarı", () => {
  it("kutu işareti kaldırılınca onay HEMEN kapanmaz; önce uyarı çıkar", () => {
    render(<SettingsForm initial={initial} defaultNotifyEmail="musteri@ornek.com" />);
    fireEvent.click(approvalBox());

    expect(screen.getByRole("alertdialog", { name: "Onayı kapatma uyarısı" })).toBeTruthy();
    expect(approvalBox().checked).toBe(true);
    // Uyarı açıkken kaydetme kapalı: yarım kalmış bir kararla ayar yazılmasın.
    expect((screen.getByRole("button", { name: "Kaydet" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("'Vazgeç' onayı açık bırakır", () => {
    render(<SettingsForm initial={initial} defaultNotifyEmail={null} />);
    fireEvent.click(approvalBox());
    fireEvent.click(screen.getByRole("button", { name: "Vazgeç" }));
    expect(approvalBox().checked).toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("'Anladım' sonrası kayıt requireApproval: false gönderir", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ settings: { ...initial, requireApproval: false } }), { status: 200 })
    );
    render(<SettingsForm initial={initial} defaultNotifyEmail={null} />);
    fireEvent.click(approvalBox());
    fireEvent.click(screen.getByRole("button", { name: "Anladım, onayı kapat" }));
    expect(approvalBox().checked).toBe(false);
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
    expect((screen.getByRole("button", { name: "Kaldır" }) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole("button", { name: "Saat ekle" }));
    expect(screen.getAllByLabelText(/yayın saati/)).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "Saat ekle" })).toBeNull();
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
});
