import { afterEach, describe, expect, it } from "vitest";
import {
  StorageNotConfiguredError,
  frameKey,
  keyBelongsToClient,
  r2Configured,
  resetStorageClientForTests,
  signGetUrl,
  videoKey,
} from "@/lib/storage-r2";

const ENV_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetStorageClientForTests();
});

describe("anahtar düzeni", () => {
  it("müşteri önekli anahtar üretir", () => {
    expect(videoKey("cl1", "po1", "mp4")).toBe("clients/cl1/videos/po1.mp4");
    expect(frameKey("cl1", "po1", 3)).toBe("clients/cl1/frames/po1/3.jpg");
  });

  it("başka öneke kaçabilecek kimliği reddeder", () => {
    expect(() => videoKey("cl1/../cl2", "po1", "mp4")).toThrow();
    expect(() => videoKey("cl1", "po1", "mp4/x")).toThrow();
    expect(() => frameKey("cl1", "po1", -1)).toThrow();
  });

  it("keyBelongsToClient yalnızca kendi önekini kabul eder", () => {
    expect(keyBelongsToClient("clients/cl1/videos/po1.mp4", "cl1")).toBe(true);
    expect(keyBelongsToClient("clients/cl10/videos/po1.mp4", "cl1")).toBe(false);
    expect(keyBelongsToClient("clients/cl1/../cl2/videos/x.mp4", "cl1")).toBe(false);
  });
});

describe("yapılandırma", () => {
  it("env yoksa açık hata verir", async () => {
    expect(r2Configured()).toBe(false);
    await expect(signGetUrl("clients/cl1/videos/po1.mp4")).rejects.toBeInstanceOf(
      StorageNotConfiguredError
    );
  });

  it("env varsa imzalı URL üretir (ağ çağrısı yok)", async () => {
    process.env.R2_ACCOUNT_ID = "acc";
    process.env.R2_ACCESS_KEY_ID = "key";
    process.env.R2_SECRET_ACCESS_KEY = "secret";
    process.env.R2_BUCKET = "bucket";
    const url = await signGetUrl("clients/cl1/videos/po1.mp4", 60);
    expect(url).toContain("acc.r2.cloudflarestorage.com");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=60");
  });
});
