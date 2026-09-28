import { describe, expect, it } from "vitest";
import { reviewNext } from "./portal-review";

type Item = Parameters<typeof reviewNext>[0][number];

const item = (id: string, overrides: Partial<Item> = {}): Item => ({
  id,
  status: "pending",
  captionStatus: "ready",
  ...overrides,
});

describe("reviewNext — onay bekleyenler kuyruk sırasıyla", () => {
  const queue = [
    item("a", { status: "approved" }),
    item("b"),
    item("c", { captionStatus: "generating" }),
    item("d"),
    item("e", { status: "approved" }),
    item("f"),
  ];

  it("sıradaki, bu videodan sonraki ilk onaylanabilir video (caption'ı hazır olmayan atlanır)", () => {
    expect(reviewNext(queue, "b")).toEqual({ nextId: "d", awaiting: 3, index: 1 });
    expect(reviewNext(queue, "d")).toEqual({ nextId: "f", awaiting: 3, index: 2 });
  });

  it("sondaki onaylanınca baştaki bekleyene döner", () => {
    expect(reviewNext(queue, "f")).toEqual({ nextId: "b", awaiting: 3, index: 3 });
  });

  it("tek bekleyen buysa sıradaki yok", () => {
    expect(reviewNext([item("a", { status: "approved" }), item("b")], "b")).toEqual({
      nextId: null,
      awaiting: 1,
      index: 1,
    });
  });

  it("bekleyen olmayan (onaylı) videodan da sıradaki bulunur, kendisi sayılmaz", () => {
    expect(reviewNext(queue, "e")).toEqual({ nextId: "f", awaiting: 3, index: null });
  });

  it("kuyrukta olmayan video: ilk bekleyen", () => {
    expect(reviewNext(queue, "yok")).toEqual({ nextId: "b", awaiting: 3, index: null });
  });
});
