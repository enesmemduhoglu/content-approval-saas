// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
  usePathname: () => "/portal/video/v1",
}));

import { VideoActions, type VideoActionsProps } from "./video-actions";

const props = (overrides: Partial<VideoActionsProps> = {}): VideoActionsProps => ({
  id: "v1",
  caption: "Caption",
  status: "approved",
  captionStatus: "ready",
  publishStatus: "idle",
  inQueue: false,
  requireApproval: true,
  canDelete: true,
  ...overrides,
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  replace.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VideoActions — kuyruk dışı video silme", () => {
  it("kuyruktan çıkarılan video: alt çubukta Sil + Kuyruğa geri al", () => {
    render(<VideoActions {...props()} />);
    expect(screen.getByRole("button", { name: "Sil" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kuyruğa geri al" })).toBeTruthy();
  });

  it("kuyruk dışındaki onay bekleyen videoda karar düğmeleri yok (önce kuyruğa alınır)", () => {
    render(<VideoActions {...props({ status: "pending" })} />);
    expect(screen.queryByRole("button", { name: "Onayla" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reddet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sil" })).toBeTruthy();
  });

  it("reddedilen video: yalnızca Sil (kuyruğa geri alınamaz)", () => {
    render(<VideoActions {...props({ status: "rejected" })} />);
    expect(screen.getByRole("button", { name: "Sil" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Kuyruğa geri al" })).toBeNull();
  });

  it("kuyruktaki videoda Sil yok", () => {
    render(<VideoActions {...props({ inQueue: true, canDelete: false })} />);
    expect(screen.queryByRole("button", { name: "Sil" })).toBeNull();
    expect(screen.getByRole("button", { name: "Kuyruktan çıkar" })).toBeTruthy();
  });

  it("Sil → onay → DELETE, sonra kuyruğa dönülür", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<VideoActions {...props()} />);

    fireEvent.click(screen.getByRole("button", { name: "Sil" }));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Video silinsin mi?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Kalıcı olarak sil" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/portal"));
    expect(fetchMock).toHaveBeenCalledWith("/api/portal/videos/v1", { method: "DELETE" });
  });

  it("silme hatası onay sayfasında kalır, sayfadan çıkılmaz", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Olmadı" }), { status: 500 }));
    render(<VideoActions {...props()} />);

    fireEvent.click(screen.getByRole("button", { name: "Sil" }));
    fireEvent.click(screen.getByRole("button", { name: "Kalıcı olarak sil" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Olmadı"));
    expect(replace).not.toHaveBeenCalled();
  });
});
