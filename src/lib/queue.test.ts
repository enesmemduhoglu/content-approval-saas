import { describe, expect, it } from "vitest";
import {
  POSITION_STEP,
  SLOT_WINDOW_MS,
  dueSlots,
  isEligible,
  needsRenumber,
  parseSlot,
  pickNext,
  positionBetween,
  projectSchedule,
  renumberPositions,
  slotInstants,
  zonedTimeToUtc,
  type QueueItem,
} from "./queue";

// Saf fonksiyonlar — DB yok. Anlar hep açık UTC ile yazılıyor ki testin
// kendisi makinenin saat dilimine bağlı olmasın.
const utc = (iso: string) => new Date(iso);
const IST = { slots: ["19:00"], timezone: "Europe/Istanbul" };
const BERLIN = "Europe/Berlin";

function item(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    queuePosition: 1,
    captionStatus: "ready",
    status: "approved",
    publishStatus: "idle",
    ...overrides,
  };
}

describe("parseSlot", () => {
  it("geçerli HH:MM'yi ayrıştırır, geçersizi reddeder", () => {
    expect(parseSlot("19:00")).toEqual({ hour: 19, minute: 0 });
    expect(parseSlot("00:05")).toEqual({ hour: 0, minute: 5 });
    expect(parseSlot("24:00")).toBeNull();
    expect(parseSlot("7:00")).toBeNull();
    expect(parseSlot("19:60")).toBeNull();
    expect(parseSlot("")).toBeNull();
  });
});

describe("zonedTimeToUtc", () => {
  it("İstanbul sabit +03:00", () => {
    expect(
      zonedTimeToUtc({ year: 2026, month: 9, day: 25, hour: 19, minute: 0 }, "Europe/Istanbul")
    ).toEqual(utc("2026-09-25T16:00:00Z"));
  });

  it("Berlin kışın +01:00, yazın +02:00 — sabit ofset varsayılmaz", () => {
    expect(zonedTimeToUtc({ year: 2026, month: 1, day: 15, hour: 19, minute: 0 }, BERLIN)).toEqual(
      utc("2026-01-15T18:00:00Z")
    );
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 15, hour: 19, minute: 0 }, BERLIN)).toEqual(
      utc("2026-07-15T17:00:00Z")
    );
  });

  it("ileri alma boşluğu (02:30 yok) → 03:30 CEST'e kayar, atlanmaz", () => {
    // 2026-03-29 Berlin: 02:00 CET → 03:00 CEST (01:00Z).
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, BERLIN)).toEqual(
      utc("2026-03-29T01:30:00Z")
    );
  });

  it("geri alma çifti (02:30 iki kez) → İLKİ seçilir", () => {
    // 2026-10-25 Berlin: 03:00 CEST → 02:00 CET (01:00Z). 02:30 hem 00:30Z hem 01:30Z.
    expect(zonedTimeToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, BERLIN)).toEqual(
      utc("2026-10-25T00:30:00Z")
    );
  });
});

describe("slotInstants", () => {
  it("yerel takvime göre gezer; gece yarısından sonraki slot UTC'de önceki güne düşer", () => {
    const out = slotInstants(
      { slots: ["01:00"], timezone: "Europe/Istanbul" },
      { from: utc("2026-09-25T00:00:00Z"), to: utc("2026-09-26T23:59:00Z") }
    );
    // Yerel 26 Eylül 01:00 = 25 Eylül 22:00Z; yerel 27 Eylül 01:00 = 26 Eylül 22:00Z.
    expect(out).toEqual([utc("2026-09-25T22:00:00Z"), utc("2026-09-26T22:00:00Z")]);
  });

  it("çoklu slotları sıralar, geçersiz ve tekrar edenleri eler", () => {
    const out = slotInstants(
      { slots: ["19:00", "bozuk", "09:30", "19:00"], timezone: "Europe/Istanbul" },
      { from: utc("2026-09-25T00:00:00Z"), to: utc("2026-09-25T20:59:00Z") }
    );
    expect(out).toEqual([utc("2026-09-25T06:30:00Z"), utc("2026-09-25T16:00:00Z")]);
  });

  it("slot yoksa boş", () => {
    expect(
      slotInstants(
        { slots: [], timezone: "Europe/Istanbul" },
        { from: utc("2026-09-25T00:00:00Z"), to: utc("2026-09-30T00:00:00Z") }
      )
    ).toEqual([]);
  });

  it("DST günü boyunca ofset değişir: aynı yerel 19:00 bir gün 18:00Z, ertesi gün 17:00Z", () => {
    const out = slotInstants(
      { slots: ["19:00"], timezone: BERLIN },
      { from: utc("2026-03-28T00:00:00Z"), to: utc("2026-03-29T23:00:00Z") }
    );
    expect(out).toEqual([utc("2026-03-28T18:00:00Z"), utc("2026-03-29T17:00:00Z")]);
  });
});

describe("dueSlots", () => {
  it("saati gelmiş, kaydı olmayan slot → publish", () => {
    const due = dueSlots(IST, utc("2026-09-25T16:04:00Z"), []);
    // Dünkü 19:00 geriye bakış penceresinin (24 saat) hemen dışında kalıyor.
    expect(due).toEqual([{ slotAt: utc("2026-09-25T16:00:00Z"), action: "publish" }]);
  });

  it("dünkü slot 24 saat içindeyse ve kaydı yoksa skip olarak döner", () => {
    const due = dueSlots(IST, utc("2026-09-25T15:30:00Z"), []);
    expect(due).toEqual([{ slotAt: utc("2026-09-24T16:00:00Z"), action: "skip" }]);
  });

  it("kaydı olan slot bir daha dönmez", () => {
    const due = dueSlots(IST, utc("2026-09-25T16:04:00Z"), [
      utc("2026-09-24T16:00:00Z"),
      utc("2026-09-25T16:00:00Z"),
    ]);
    expect(due).toEqual([]);
  });

  it("slot saati henüz gelmediyse boş", () => {
    expect(
      dueSlots(IST, utc("2026-09-25T15:59:00Z"), [utc("2026-09-24T16:00:00Z")])
    ).toEqual([]);
  });

  it("pencere tam 1 saat: sınırda publish, bir dakika sonra skip (K8)", () => {
    const slot = utc("2026-09-25T16:00:00Z");
    const tam = new Date(slot.getTime() + SLOT_WINDOW_MS);
    const gec = new Date(slot.getTime() + SLOT_WINDOW_MS + 60_000);
    const kayit = [utc("2026-09-24T16:00:00Z")];
    expect(dueSlots(IST, tam, kayit)).toEqual([{ slotAt: slot, action: "publish" }]);
    expect(dueSlots(IST, gec, kayit)).toEqual([{ slotAt: slot, action: "skip" }]);
  });

  it("kesinti sonrası birikmiş slotların hepsi skip — art arda yayın yok", () => {
    const due = dueSlots(
      { slots: ["09:00", "13:00", "19:00"], timezone: "Europe/Istanbul" },
      utc("2026-09-25T18:30:00Z"), // yerel 21:30
      []
    );
    expect(due.every((d) => d.action === "skip")).toBe(true);
    // Geriye yalnızca 24 saat bakılır: dünün 21:30 öncesi slotları yok.
    expect(due.map((d) => d.slotAt)).toEqual([
      utc("2026-09-25T06:00:00Z"),
      utc("2026-09-25T10:00:00Z"),
      utc("2026-09-25T16:00:00Z"),
    ]);
  });

  it("ayarın kurulduğu andan önceki slotlar üretilmez", () => {
    const due = dueSlots(
      { ...IST, createdAt: utc("2026-09-25T10:00:00Z") },
      utc("2026-09-25T16:04:00Z"),
      []
    );
    expect(due).toEqual([{ slotAt: utc("2026-09-25T16:00:00Z"), action: "publish" }]);
  });

  it("gün dönümü: yerel 00:30 slotu, UTC'de önceki günün 21:30'u", () => {
    const due = dueSlots(
      { slots: ["00:30"], timezone: "Europe/Istanbul" },
      utc("2026-09-25T21:40:00Z"), // yerel 26 Eylül 00:40
      [utc("2026-09-24T21:30:00Z")]
    );
    expect(due).toEqual([{ slotAt: utc("2026-09-25T21:30:00Z"), action: "publish" }]);
  });

  it("DST: Berlin yaz saatine geçtiği gün 19:00 slotu 17:00Z'de vadesi gelir", () => {
    const due = dueSlots(
      { slots: ["19:00"], timezone: BERLIN },
      utc("2026-03-29T17:05:00Z"), // yerel 19:05 CEST
      [utc("2026-03-28T18:00:00Z")]
    );
    expect(due).toEqual([{ slotAt: utc("2026-03-29T17:00:00Z"), action: "publish" }]);
    // Aynı an sabit +01:00 varsayılsaydı slot 18:00Z olurdu ve henüz gelmemiş sayılırdı.
  });
});

describe("pickNext", () => {
  it("queuePosition sırasındaki ilk uygun videoyu seçer", () => {
    const queue = [
      item({ id: "c", queuePosition: 3 }),
      item({ id: "a", queuePosition: 1 }),
      item({ id: "b", queuePosition: 2 }),
    ];
    expect(pickNext(queue, true)?.id).toBe("a");
  });

  it("onay AÇIK: baştaki onaysızsa sıradaki ilk ONAYLI seçilir (K9)", () => {
    const queue = [
      item({ id: "a", queuePosition: 1, status: "pending" }),
      item({ id: "b", queuePosition: 2, status: "approved" }),
    ];
    expect(pickNext(queue, true)?.id).toBe("b");
  });

  it("onay AÇIK: hiç onaylı yoksa null — onaysız video ASLA seçilmez", () => {
    const queue = [
      item({ id: "a", queuePosition: 1, status: "pending" }),
      item({ id: "b", queuePosition: 2, status: "pending" }),
    ];
    expect(pickNext(queue, true)).toBeNull();
  });

  it("onay KAPALI: bekleyen de seçilir, sıra korunur", () => {
    const queue = [
      item({ id: "a", queuePosition: 1, status: "pending" }),
      item({ id: "b", queuePosition: 2, status: "approved" }),
    ];
    expect(pickNext(queue, false)?.id).toBe("a");
  });

  it("onay KAPALI olsa bile reddedilmiş/revizyonda/taslak seçilmez", () => {
    const queue = [
      item({ id: "a", queuePosition: 1, status: "rejected" }),
      item({ id: "b", queuePosition: 2, status: "revision_requested" }),
      item({ id: "c", queuePosition: 3, status: "draft" }),
      item({ id: "d", queuePosition: 4, status: "pending" }),
    ];
    expect(pickNext(queue, false)?.id).toBe("d");
  });

  it("caption hazır değilse atlanır", () => {
    const queue = [
      item({ id: "a", queuePosition: 1, captionStatus: "pending" }),
      item({ id: "b", queuePosition: 2, captionStatus: "generating" }),
      item({ id: "c", queuePosition: 3, captionStatus: "failed" }),
      item({ id: "d", queuePosition: 4, captionStatus: null }),
      item({ id: "e", queuePosition: 5 }),
    ];
    expect(pickNext(queue, true)?.id).toBe("e");
  });

  it("failed video atlanır — hata kuyruğu durdurmaz", () => {
    const queue = [
      item({ id: "a", queuePosition: 1, publishStatus: "failed" }),
      item({ id: "b", queuePosition: 2 }),
    ];
    expect(pickNext(queue, true)?.id).toBe("b");
  });

  it("yolda ya da yolun sonundaki video seçilmez", () => {
    for (const publishStatus of [
      "publishing",
      "published",
      "duplicate",
      "scheduled",
      "skipped",
    ] as const) {
      expect(pickNext([item({ id: "a", publishStatus })], false)).toBeNull();
    }
  });

  it("kuyruktan çıkarılmış (queuePosition null) seçilmez", () => {
    expect(pickNext([item({ id: "a", queuePosition: null })], false)).toBeNull();
  });

  it("boş kuyruk → null", () => {
    expect(pickNext([], true)).toBeNull();
    expect(pickNext([], false)).toBeNull();
  });

  it("isEligible onay moduna göre ayrışır", () => {
    const pending = item({ id: "a", status: "pending" });
    expect(isEligible(pending, true)).toBe(false);
    expect(isEligible(pending, false)).toBe(true);
  });
});

describe("positionBetween / needsRenumber", () => {
  it("komşulara göre pozisyon", () => {
    expect(positionBetween(null, null)).toBe(POSITION_STEP);
    expect(positionBetween(1024, null)).toBe(2048);
    expect(positionBetween(null, 1024)).toBe(0);
    expect(positionBetween(1024, 2048)).toBe(1536);
  });

  it("boşluk yeterliyse yeniden numaralama gerekmez", () => {
    expect(needsRenumber(1024, 2048)).toBe(false);
    expect(needsRenumber(null, 5)).toBe(false);
    expect(needsRenumber(5, null)).toBe(false);
  });

  it("art arda aynı boşluğa taşıma sonunda yeniden numaralama ister", () => {
    let before = 1024;
    const after = 2048;
    let steps = 0;
    while (!needsRenumber(before, after)) {
      before = positionBetween(before, after);
      steps += 1;
      expect(steps).toBeLessThan(100);
    }
    // Eşik float tükenmeden önce devreye girer: ortalama hâlâ komşulardan farklı.
    expect(steps).toBeGreaterThan(20);
  });

  it("renumberPositions eşit aralıklı yazar", () => {
    expect(renumberPositions(["x", "y", "z"])).toEqual([
      { id: "x", queuePosition: 1024 },
      { id: "y", queuePosition: 2048 },
      { id: "z", queuePosition: 3072 },
    ]);
  });
});

describe("projectSchedule", () => {
  const now = utc("2026-09-25T09:00:00Z"); // yerel 12:00

  it("sıradaki videoları sıradaki slotlara yerleştirir", () => {
    const queue = [
      item({ id: "a", queuePosition: 1 }),
      item({ id: "b", queuePosition: 2 }),
      item({ id: "c", queuePosition: 3 }),
    ];
    const out = projectSchedule(
      queue,
      { slots: ["19:00"], timezone: "Europe/Istanbul", requireApproval: true, paused: false },
      now,
      3
    );
    expect(out).toEqual([
      { postId: "a", slotAt: utc("2026-09-25T16:00:00Z") },
      { postId: "b", slotAt: utc("2026-09-26T16:00:00Z") },
      { postId: "c", slotAt: utc("2026-09-27T16:00:00Z") },
    ]);
  });

  it("onay açıkken onaysız video takvimde görünmez — tick de onu seçmez", () => {
    const queue = [
      item({ id: "a", queuePosition: 1, status: "pending" }),
      item({ id: "b", queuePosition: 2 }),
    ];
    const settings = {
      slots: ["19:00"],
      timezone: "Europe/Istanbul",
      requireApproval: true,
      paused: false,
    };
    expect(projectSchedule(queue, settings, now, 5)).toEqual([
      { postId: "b", slotAt: utc("2026-09-25T16:00:00Z") },
    ]);
    // Onay kapalıysa ikisi de sırayla.
    expect(
      projectSchedule(queue, { ...settings, requireApproval: false }, now, 5).map((p) => p.postId)
    ).toEqual(["a", "b"]);
  });

  it("günde birden çok slot ve n sınırı", () => {
    const queue = ["a", "b", "c", "d"].map((id, i) => item({ id, queuePosition: i + 1 }));
    const out = projectSchedule(
      queue,
      { slots: ["09:00", "19:00"], timezone: "Europe/Istanbul", requireApproval: true, paused: false },
      now,
      3
    );
    // 09:00 geçti; bugün 19:00, yarın 09:00 ve 19:00.
    expect(out).toEqual([
      { postId: "a", slotAt: utc("2026-09-25T16:00:00Z") },
      { postId: "b", slotAt: utc("2026-09-26T06:00:00Z") },
      { postId: "c", slotAt: utc("2026-09-26T16:00:00Z") },
    ]);
  });

  it("duraklatılmış kuyrukta takvim boş", () => {
    expect(
      projectSchedule(
        [item({ id: "a" })],
        { slots: ["19:00"], timezone: "Europe/Istanbul", requireApproval: true, paused: true },
        now,
        3
      )
    ).toEqual([]);
  });

  it("uygun video yoksa boş", () => {
    expect(
      projectSchedule(
        [item({ id: "a", publishStatus: "failed" })],
        { slots: ["19:00"], timezone: "Europe/Istanbul", requireApproval: false, paused: false },
        now,
        3
      )
    ).toEqual([]);
  });
});
