import { describe, expect, it } from "vitest";
import { cleanupTestResources, TestSandboxes } from "../testing.js";

describe("test sandbox ownership", () => {
  it("destroys every original provider's handles even if an earlier destroy fails, and can retry", async () => {
    const owned = new TestSandboxes();
    const calls: string[] = [];
    let fail = true;
    const first = owned.track({
      createSandbox: async () => ({ id: "first" }),
      destroySandbox: async (id: string) => {
        calls.push(id);
        if (fail) throw new Error("first cleanup failed");
      },
    });
    const second = owned.track({
      createSandbox: async () => ({ id: "second" }),
      destroySandbox: async (id: string) => {
        calls.push(id);
      },
    });
    await first.createSandbox();
    await second.createSandbox();
    await expect(owned.cleanup()).rejects.toThrow(
      "Test sandbox cleanup failed",
    );
    expect(calls).toEqual(["first", "second"]);
    fail = false;
    await owned.cleanup();
    await owned.cleanup();
    expect(calls).toEqual(["first", "second", "first"]);
  });

  it("joins allocations already in flight before destroying their handles", async () => {
    const owned = new TestSandboxes();
    const calls: string[] = [];
    let finish: ((sandbox: { id: string }) => void) | undefined;
    const provider = owned.track({
      createSandbox: () =>
        new Promise<{ id: string }>((resolve) => {
          finish = resolve;
        }),
      destroySandbox: async (id: string) => {
        calls.push(id);
      },
    });
    const allocation = provider.createSandbox();
    let cleaned = false;
    const cleanup = owned.cleanup().then(() => {
      cleaned = true;
    });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    finish?.({ id: "late-allocation" });
    await allocation;
    await cleanup;
    expect(calls).toEqual(["late-allocation"]);
  });

  it("still destroys owned handles when an in-flight allocation fails", async () => {
    const owned = new TestSandboxes();
    const calls: string[] = [];
    let rejectAllocation: ((error: Error) => void) | undefined;
    const provider = owned.track({
      createSandbox: () =>
        new Promise<{ id: string }>((_resolve, reject) => {
          rejectAllocation = reject;
        }),
      destroySandbox: async (id: string) => {
        calls.push(id);
      },
    });
    owned.record(provider, "already-owned");
    const allocation = provider.createSandbox();
    const allocationResult = allocation.catch((error: unknown) => error);
    const cleanup = owned.cleanup();
    rejectAllocation?.(new Error("allocation failed"));
    await expect(cleanup).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "allocation failed" })],
    });
    expect(await allocationResult).toMatchObject({
      message: "allocation failed",
    });
    expect(calls).toEqual(["already-owned"]);
  });

  it("does not destroy a sandbox again after explicit fixture cleanup", async () => {
    const owned = new TestSandboxes();
    const calls: string[] = [];
    const provider = owned.track({
      createSandbox: async () => ({ id: "sandbox" }),
      destroySandbox: async (id: string) => {
        calls.push(id);
      },
    });
    const sandbox = await provider.createSandbox();
    await provider.destroySandbox(sandbox.id);
    await owned.cleanup();
    expect(calls).toEqual(["sandbox"]);
  });

  it("attempts every resource shutdown and keeps diagnostics when cleanup fails", async () => {
    const calls: string[] = [];
    await expect(
      cleanupTestResources(
        [
          () => {
            calls.push("loop");
            throw new Error("loop cleanup failed");
          },
          () => {
            calls.push("sandboxes");
            throw new Error("sandbox cleanup failed");
          },
          () => {
            calls.push("database");
          },
        ],
        () => {
          calls.push("remove directory");
        },
      ),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "loop cleanup failed" }),
        expect.objectContaining({ message: "sandbox cleanup failed" }),
      ],
    });
    expect(calls).toEqual(["loop", "sandboxes", "database"]);
  });
});
