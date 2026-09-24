import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  autoApprovePost,
  claimPostForSlot,
  claimSlotRun,
  finishSlotRun,
  loadQueue,
  recordSlotOutcomeForPost,
} from "./queue-db";
import { createAgency, createInstagramClient, resetDb } from "@tests/helpers/db";
import { createQueuePost } from "@tests/helpers/queue";

beforeEach(async () => {
  await resetDb();
});

async function seed() {
  const agency = await createAgency();
  const client = await createInstagramClient(agency.id);
  return { agency, client };
}

const SLOT = new Date("2026-09-25T16:00:00Z");

describe("claimSlotRun", () => {
  it("aynı slotu yalnızca bir kez sahiplenir — UNIQUE çakışması false döner", async () => {
    const { client } = await seed();
    expect(await claimSlotRun(client.id, SLOT)).toBe(true);
    expect(await claimSlotRun(client.id, SLOT)).toBe(false);
    expect(await claimSlotRun(client.id, SLOT, { outcome: "skipped" })).toBe(false);
    expect(await db.slotRun.count()).toBe(1);
  });

  it("eşzamanlı iki INSERT'ten tam biri kazanır", async () => {
    const { client } = await seed();
    const results = await Promise.all([
      claimSlotRun(client.id, SLOT),
      claimSlotRun(client.id, SLOT),
      claimSlotRun(client.id, SLOT),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("farklı müşterilerin aynı saatteki slotları birbirini engellemez", async () => {
    const { client } = await seed();
    const { client: other } = await seed();
    expect(await claimSlotRun(client.id, SLOT)).toBe(true);
    expect(await claimSlotRun(other.id, SLOT)).toBe(true);
  });
});

describe("finishSlotRun / recordSlotOutcomeForPost", () => {
  it("yazılmış sonucun üzerine yazmaz — önce yazan kalır", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    await claimSlotRun(client.id, SLOT);
    await db.slotRun.updateMany({ where: { clientId: client.id }, data: { postId: post.id } });

    await recordSlotOutcomeForPost(post.id, "published");
    await finishSlotRun(client.id, SLOT, { outcome: "failed", detail: "geç kalan" });

    const run = await db.slotRun.findFirstOrThrow({ where: { clientId: client.id } });
    expect(run.outcome).toBe("published");
  });
});

describe("claimPostForSlot", () => {
  it("aynı postu iki farklı slot sahiplenemez", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    const now = new Date("2026-09-25T16:40:00Z");
    const results = await Promise.all([
      claimPostForSlot({ clientId: client.id, postId: post.id, slotAt: SLOT, now }),
      claimPostForSlot({
        clientId: client.id,
        postId: post.id,
        slotAt: new Date("2026-09-25T16:30:00Z"),
        now,
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("başka müşterinin postunu sahiplenemez", async () => {
    const { agency, client } = await seed();
    const { client: other } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    expect(
      await claimPostForSlot({ clientId: other.id, postId: post.id, slotAt: SLOT, now: SLOT })
    ).toBe(false);
  });

  it("eski (bayat) sahiplenme yeniden alınabilir — tekrar denenen video", async () => {
    const { agency, client } = await seed();
    const post = await createQueuePost(agency.id, client.id);
    await db.post.update({
      where: { id: post.id },
      data: { slotAt: new Date("2026-09-24T16:00:00Z") },
    });
    expect(
      await claimPostForSlot({ clientId: client.id, postId: post.id, slotAt: SLOT, now: SLOT })
    ).toBe(true);
  });
});

describe("autoApprovePost", () => {
  it("yalnızca bekleyen postu onaylar ve audit yazar", async () => {
    const { agency, client } = await seed();
    const pending = await createQueuePost(agency.id, client.id, { status: "pending" });
    const rejected = await createQueuePost(agency.id, client.id, { status: "rejected" });

    expect(await autoApprovePost(client.id, pending.id)).toBe(true);
    expect(await autoApprovePost(client.id, pending.id)).toBe(false);
    expect(await autoApprovePost(client.id, rejected.id)).toBe(false);

    expect((await db.post.findUniqueOrThrow({ where: { id: rejected.id } })).status).toBe(
      "rejected"
    );
    const audits = await db.approvalAudit.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ postId: pending.id, action: "auto_approved", ip: "system" });
  });

  it("başka müşterinin postunu onaylamaz", async () => {
    const { agency, client } = await seed();
    const { client: other } = await seed();
    const post = await createQueuePost(agency.id, client.id, { status: "pending" });
    expect(await autoApprovePost(other.id, post.id)).toBe(false);
  });
});

describe("loadQueue", () => {
  it("yalnızca bu müşterinin kuyruktaki portal postları, sırasıyla", async () => {
    const { agency, client } = await seed();
    const { client: other } = await seed();
    const b = await createQueuePost(agency.id, client.id, { queuePosition: 2 });
    const a = await createQueuePost(agency.id, client.id, { queuePosition: 1 });
    await createQueuePost(agency.id, client.id, { queuePosition: null });
    await createQueuePost(agency.id, other.id);

    expect((await loadQueue(client.id)).map((p) => p.id)).toEqual([a.id, b.id]);
  });
});
