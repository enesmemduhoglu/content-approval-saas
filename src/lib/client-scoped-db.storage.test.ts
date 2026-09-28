import { describe, expect, it, vi } from "vitest";

const prefixUsage = vi.fn();
vi.mock("@/lib/storage-r2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage-r2")>()),
  prefixUsage: (prefix: string) => prefixUsage(prefix),
}));

import { getClientScopedDb } from "@/lib/client-scoped-db";

// Depolama göstergesi: önek istekten değil OTURUMDAN kurulur — başka müşterinin
// kullanımı hiçbir yoldan okunamaz.
describe("storage.usage", () => {
  it("yalnızca oturumdaki müşterinin önekini toplar", async () => {
    const usage = { totalBytes: 1, videoBytes: 1, videoCount: 1, frameBytes: 0 };
    prefixUsage.mockResolvedValue(usage);
    const result = await getClientScopedDb({ clientUserId: "u", clientId: "cl_a" }).storage.usage();
    expect(result).toBe(usage);
    expect(prefixUsage).toHaveBeenCalledWith("clients/cl_a/");
  });
});
