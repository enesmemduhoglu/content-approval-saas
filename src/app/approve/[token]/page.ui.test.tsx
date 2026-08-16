// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: vi.fn().mockResolvedValue(false),
}));

const findUnique = vi.fn();
const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    approvalLink: { findUnique: (...args: unknown[]) => findUnique(...args) },
    post: { findMany: (...args: unknown[]) => findMany(...args) },
  },
}));

import ApprovePage from "./page";

function seedPage({
  instagramConnected,
  status = "pending",
  publishStatus = "idle",
  igPermalink = null,
}: {
  instagramConnected: boolean;
  status?: string;
  publishStatus?: string;
  igPermalink?: string | null;
}) {
  const client = {
    id: "client-1",
    name: "Müşteri",
    instagramUserId: instagramConnected ? "17841400000000000" : null,
    instagramAccessToken: instagramConnected ? "IGAA-test-token" : null,
  };
  findUnique.mockResolvedValue({
    token: "tok",
    expiresAt: new Date(Date.now() + 86_400_000),
    postId: "post-1",
    post: {
      id: "post-1",
      clientId: client.id,
      caption: "Ana post",
      status,
      publishStatus,
      igPermalink,
      client,
      agency: { name: "Ajans", logoUrl: null, brandColor: null },
      images: [{ id: "img-1", url: "/uploads/a.png" }],
    },
  });
  findMany.mockResolvedValue([
    {
      id: "post-2",
      caption: "Diğer post",
      approvalLink: { token: "tok-2" },
      images: [{ id: "img-2", url: "/uploads/b.png" }],
    },
  ]);
}

describe("Onay sayfası — yayın hedefli müşteride toplu onay", () => {
  it("Instagram bağlıysa 'Tümünü onayla' yerine tek tek onay açıklaması çıkar", async () => {
    seedPage({ instagramConnected: true });
    render(await ApprovePage({ params: Promise.resolve({ token: "tok" }) }));

    expect(screen.queryByText(/Tümünü onayla/)).toBeNull();
    expect(screen.getByText(/tek tek onaylaman gerekiyor/)).toBeTruthy();
    // Diğer postlar yine listelenir; sadece toplu onay yok.
    expect(screen.getByText("Diğer post")).toBeTruthy();
  });

  it("Instagram bağlı değilse toplu onay butonu eskisi gibi görünür", async () => {
    seedPage({ instagramConnected: false });
    render(await ApprovePage({ params: Promise.resolve({ token: "tok" }) }));

    expect(screen.getByText(/Tümünü onayla/)).toBeTruthy();
    expect(screen.queryByText(/tek tek onaylaman gerekiyor/)).toBeNull();
  });

  it("onaylanmış ama yayınlanmamış post için yayınlama butonu çıkar", async () => {
    // Eski toplu onaylardan kalan postların kurtarma yolu.
    seedPage({ instagramConnected: true, status: "approved", publishStatus: "idle" });
    render(await ApprovePage({ params: Promise.resolve({ token: "tok" }) }));

    expect(screen.getByText(/Instagram'a henüz yayınlanmadı/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Instagram'a yayınla" })).toBeTruthy();
  });
});

describe("Onay sayfası — mükerrer yayın engellenmiş post", () => {
  it("neden yayınlanmadığını söyler ve canlı gönderiye link verir", async () => {
    seedPage({
      instagramConnected: true,
      status: "approved",
      publishStatus: "duplicate",
      igPermalink: "https://instagram.com/p/CANLI/",
    });
    render(await ApprovePage({ params: Promise.resolve({ token: "tok" }) }));

    expect(screen.getByText(/zaten Instagram'da yayında/)).toBeTruthy();
    const link = screen.getByText("Instagram'da gör") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://instagram.com/p/CANLI/");
  });

  it("'tekrar dene' butonu ÇIKMAZ — tekrarlamak sorunun kendisi", async () => {
    seedPage({ instagramConnected: true, status: "approved", publishStatus: "duplicate" });
    render(await ApprovePage({ params: Promise.resolve({ token: "tok" }) }));

    expect(screen.queryByRole("button", { name: /tekrar dene/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Instagram'a yayınla" })).toBeNull();
  });
});
