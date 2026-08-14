import { describe, expect, it } from "vitest";
import {
  AppStorageService,
  AppStorageSnapshotTooLargeError,
} from "../services/app-storage-service.js";

const identity = { tenantId: "t", externalUserId: "u" };

/** Quota rejection happens before any DB access — a null db proves it. */
const service = new AppStorageService(null as never);

describe("AppStorageService quota", () => {
  it("rejects a snapshot with too many keys before touching the db", async () => {
    const data = Object.fromEntries(
      Array.from({ length: 513 }, (_, i) => [`k${i}`, "v"]),
    );
    await expect(service.put(identity, "p", "a", data)).rejects.toThrow(
      AppStorageSnapshotTooLargeError,
    );
  });

  it("rejects an oversized snapshot before touching the db", async () => {
    const data = { big: "x".repeat(300 * 1024) };
    await expect(service.put(identity, "p", "a", data)).rejects.toThrow(
      AppStorageSnapshotTooLargeError,
    );
  });

  it("rejects non-string values before touching the db", async () => {
    const data = { nested: { a: 1 } } as unknown as Record<string, string>;
    await expect(service.put(identity, "p", "a", data)).rejects.toThrow(
      AppStorageSnapshotTooLargeError,
    );
  });
});
