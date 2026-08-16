// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TokenAlerts } from "./token-alert";

afterEach(cleanup);

describe("TokenAlerts", () => {
  it("uyarı yoksa hiçbir şey basmaz", () => {
    const { container } = render(<TokenAlerts alerts={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("yakında dolan token için uyarı tonunda, gün sayısıyla gösterir", () => {
    render(
      <TokenAlerts
        alerts={[{ clientId: "c1", clientName: "Müşteri A", daysLeft: 7, expired: false }]}
      />
    );
    const alert = screen.getByRole("status");
    expect(alert.textContent).toContain("Müşteri A");
    expect(alert.textContent).toContain("7 gün sonra doluyor");
    expect(alert.textContent).toContain("refresh_access_token");
    expect(alert.className).toContain("token-alert-soon");
  });

  it("süresi dolmuşsa hata tonunda ve yayının durduğunu söyler", () => {
    render(
      <TokenAlerts
        alerts={[{ clientId: "c1", clientName: "Müşteri B", daysLeft: -3, expired: true }]}
      />
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Müşteri B");
    expect(alert.textContent).toContain("3 gün önce doldu");
    expect(alert.textContent).toContain("Yayın şu an durmuş durumda");
    expect(alert.className).toContain("token-alert-expired");
  });

  it("bugün dolan token için 0 gün yerine 'bugün doldu' yazar", () => {
    render(
      <TokenAlerts
        alerts={[{ clientId: "c1", clientName: "Müşteri C", daysLeft: 0, expired: true }]}
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("bugün doldu");
  });

  it("birden çok müşteri için ayrı şeritler basar", () => {
    render(
      <TokenAlerts
        alerts={[
          { clientId: "c1", clientName: "Müşteri B", daysLeft: -1, expired: true },
          { clientId: "c2", clientName: "Müşteri A", daysLeft: 4, expired: false },
        ]}
      />
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
