import { describe, expect, it } from "vitest";
import { planMove, positionAtEnd } from "@/lib/portal-order";

const q = (...positions: number[]) =>
  positions.map((queuePosition, i) => ({ id: String.fromCharCode(97 + i), queuePosition }));

describe("planMove", () => {
  it("başa taşıma: ilk elemanın bir eksiği", () => {
    expect(planMove(q(1, 2, 3), "c", { beforeId: "a" })).toEqual({ kind: "single", position: 0 });
  });

  it("sona taşıma: son elemanın bir fazlası", () => {
    expect(planMove(q(1, 2, 3), "a", { afterId: "c" })).toEqual({ kind: "single", position: 4 });
  });

  it("araya taşıma: komşuların ortalaması", () => {
    expect(planMove(q(1, 2, 3), "a", { afterId: "b" })).toEqual({ kind: "single", position: 2.5 });
    expect(planMove(q(1, 2, 3), "c", { beforeId: "b" })).toEqual({ kind: "single", position: 1.5 });
  });

  it("float çözünürlüğü tükenince yeniden numaralama sırası döner", () => {
    const plan = planMove(q(1, 1 + Number.EPSILON, 9), "c", { afterId: "a" });
    expect(plan).toEqual({ kind: "renumber", order: ["a", "c", "b"] });
  });

  it("tekrarlı taşımada 60 kez aynı araya girildiğinde yeniden numaralamaya düşer", () => {
    let items = q(1, 2, 3);
    let renumbered = false;
    for (let i = 0; i < 60 && !renumbered; i++) {
      // Hep c'yi a ile (a'nın hemen arkasındaki) arasına sok.
      const order = items.map((x) => x.id);
      const moving = order[order.length - 1];
      const plan = planMove(items, moving, { afterId: "a" });
      if (plan.kind === "renumber") {
        renumbered = true;
        break;
      }
      if (plan.kind !== "single") throw new Error("beklenmedik");
      items = items
        .map((x) => (x.id === moving ? { ...x, queuePosition: plan.position } : x))
        .sort((x, y) => x.queuePosition - y.queuePosition);
    }
    expect(renumbered).toBe(true);
  });

  it("iki komşu verilip yan yana değilse stale", () => {
    expect(planMove(q(1, 2, 3, 4), "d", { afterId: "a", beforeId: "c" })).toEqual({
      kind: "error",
      reason: "stale",
    });
  });

  it("iki komşu yan yanaysa kabul", () => {
    expect(planMove(q(1, 2, 3), "c", { afterId: "a", beforeId: "b" })).toEqual({
      kind: "single",
      position: 1.5,
    });
  });

  it("bilinmeyen komşu / kuyrukta olmayan video / kendine taşıma", () => {
    expect(planMove(q(1, 2), "a", { beforeId: "zz" })).toMatchObject({ reason: "anchor_not_found" });
    expect(planMove(q(1, 2), "zz", { beforeId: "a" })).toMatchObject({ reason: "not_in_queue" });
    expect(planMove(q(1, 2), "a", { beforeId: "a" })).toMatchObject({ reason: "self" });
  });
});

describe("positionAtEnd", () => {
  it("boş kuyrukta 1, doluysa en büyüğün tam sayı üstü", () => {
    expect(positionAtEnd(null)).toBe(1);
    expect(positionAtEnd(3)).toBe(4);
    expect(positionAtEnd(3.5)).toBe(4);
    expect(positionAtEnd(-2.5)).toBe(-2);
  });
});
