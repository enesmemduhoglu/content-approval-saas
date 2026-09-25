// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

import { CodeLoginForm, RESEND_COOLDOWN_SECONDS } from "./code-login-form";
import { PortalLoginForm } from "./login-form";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const codeInput = () => screen.getByLabelText("Giriş kodu") as HTMLInputElement;
const boxes = () => screen.getAllByTestId("kod-kutusu");

describe("CodeLoginForm — 6 kutulu kod alanı", () => {
  it("tek gerçek alan: sayısal klavye, one-time-code, 6 hane", () => {
    render(<CodeLoginForm initialEmail="furkan@ornek.com" />);
    const input = codeInput();
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.maxLength).toBe(6);
    // Görünür kutular yalnızca görüntü: ekran okuyucu tek alanı duyar.
    expect(boxes()).toHaveLength(6);
    boxes().forEach((box) => expect(box.getAttribute("aria-hidden")).toBe("true"));
  });

  it("yazılan rakamlar kutulara dağılır, rakam olmayanlar atılır", () => {
    render(<CodeLoginForm initialEmail="furkan@ornek.com" />);
    fireEvent.change(codeInput(), { target: { value: "4a8 2" } });
    expect(codeInput().value).toBe("482");
    expect(boxes().map((b) => b.textContent)).toEqual(["4", "8", "2", "", "", ""]);
  });

  it("adres maskeli gösterilir; 6 hane dolunca Giriş yap kodu gönderir", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<CodeLoginForm initialEmail="furkan@ornek.com" />);
    expect(screen.getByText("f••••@ornek.com")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Giriş yap" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(codeInput(), { target: { value: "123456" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/login/code");
    expect(JSON.parse(init.body)).toEqual({ email: "furkan@ornek.com", code: "123456" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/portal"));
  });

  it("yanlış kodda hata gösterilir ve alan temizlenir", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Kod hatalı" }), { status: 400 }));
    render(<CodeLoginForm initialEmail="furkan@ornek.com" />);
    fireEvent.change(codeInput(), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Giriş yap" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Kod hatalı");
    expect(codeInput().value).toBe("");
  });

  it("'Kodu tekrar gönder' sayaç bitene kadar kapalı, sonra aynı adrese yeni e-posta ister", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "ok" }), { status: 200 }));
    render(<CodeLoginForm initialEmail="furkan@ornek.com" />);
    const resend = () => screen.getByRole("button", { name: /Kodu tekrar gönder/ }) as HTMLButtonElement;
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toContain("1:00");
    for (let i = 0; i < RESEND_COOLDOWN_SECONDS; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(resend().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(resend());
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/portal/login");
    expect(JSON.parse(init.body)).toEqual({ email: "furkan@ornek.com" });
    expect(resend().disabled).toBe(true);
  });
});

describe("PortalLoginForm — e-posta adımı", () => {
  it("gönderimden sonra kod adımına geçer", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "ok" }), { status: 200 }));
    render(<PortalLoginForm />);
    fireEvent.change(screen.getByLabelText("E-posta adresin"), { target: { value: "furkan@ornek.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Kod gönder" }));
    expect(await screen.findByLabelText("Giriş kodu")).toBeTruthy();
    expect(screen.getByText("f••••@ornek.com")).toBeTruthy();
  });

  it("'Kodum var' e-posta alanıyla birlikte kod adımını açar", () => {
    render(<PortalLoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "Kodum var" }));
    expect(screen.getByLabelText("E-posta adresin")).toBeTruthy();
    expect(screen.getByLabelText("Giriş kodu")).toBeTruthy();
  });
});
