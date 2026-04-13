import { describe, expect, it, vi } from "vitest";
import type { SandboxStore } from "../sandbox-manager.js";
import { SandboxManagerImpl } from "../sandbox-manager.js";
import type {
  CreateSandboxOpts,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "../types.js";

function createMockProvider(): SandboxProvider {
  let nextId = 1;
  const statuses = new Map<string, SandboxStatus>();

  return {
    createSandbox: vi.fn(
      async (_opts: CreateSandboxOpts): Promise<SandboxHandle> => {
        const id = `sandbox-${nextId++}`;
        statuses.set(id, "started");
        return {
          id,
          providerId: id,
          sandboxType: "execution",
          status: "started",
        };
      },
    ),
    startSandbox: vi.fn(async (id: string) => {
      statuses.set(id, "started");
    }),
    stopSandbox: vi.fn(async (id: string) => {
      statuses.set(id, "stopped");
    }),
    destroySandbox: vi.fn(async (_id: string) => {}),
    getSandboxStatus: vi.fn(async (id: string): Promise<SandboxStatus> => {
      return statuses.get(id) ?? "error";
    }),
    executeCommand: vi.fn(async () => ({ exitCode: 0, result: "" })),
    uploadFiles: vi.fn(async () => {}),
    downloadFile: vi.fn(async () => ""),
    gitClone: vi.fn(async () => {}),
    gitCheckout: vi.fn(async () => {}),
  };
}

function createMockStore(): SandboxStore & {
  records: Map<
    string,
    {
      id: string;
      providerId: string;
      projectId: string;
      sandboxType: "execution" | "dev";
      commitSha: string | null;
      userId: string | null;
      status: string;
    }
  >;
} {
  let nextId = 1;
  const records = new Map<
    string,
    {
      id: string;
      providerId: string;
      projectId: string;
      sandboxType: "execution" | "dev";
      commitSha: string | null;
      userId: string | null;
      status: string;
    }
  >();

  return {
    records,
    findSandbox: vi.fn(async (opts) => {
      for (const record of records.values()) {
        if (
          record.projectId === opts.projectId &&
          record.sandboxType === opts.sandboxType &&
          (opts.commitSha === undefined ||
            record.commitSha === opts.commitSha) &&
          (opts.userId === undefined || record.userId === opts.userId)
        ) {
          return record;
        }
      }
      return null;
    }),
    insertSandbox: vi.fn(async (record) => {
      const id = `rec-${nextId++}`;
      const full = { ...record, id };
      records.set(id, full);
      return full;
    }),
    updateStatus: vi.fn(async (id: string, status: string) => {
      const rec = records.get(id);
      if (rec) rec.status = status;
    }),
    updateLastUsed: vi.fn(async () => {}),
  };
}

describe("SandboxManagerImpl", () => {
  describe("ensureExecSandbox", () => {
    it("creates a new execution sandbox when none exists", async () => {
      const provider = createMockProvider();
      const store = createMockStore();
      const manager = new SandboxManagerImpl({ provider, store });

      const handle = await manager.ensureExecSandbox({
        projectId: "proj-1",
        commitSha: "abc123",
      });

      expect(handle.status).toBe("started");
      expect(handle.sandboxType).toBe("execution");
      expect(provider.createSandbox).toHaveBeenCalledTimes(1);
      expect(store.insertSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          sandboxType: "execution",
          commitSha: "abc123",
          userId: null,
        }),
      );
    });

    it("reuses an existing running execution sandbox", async () => {
      const provider = createMockProvider();
      const store = createMockStore();
      const manager = new SandboxManagerImpl({ provider, store });

      const first = await manager.ensureExecSandbox({
        projectId: "proj-1",
        commitSha: "abc123",
      });

      const second = await manager.ensureExecSandbox({
        projectId: "proj-1",
        commitSha: "abc123",
      });

      expect(first.id).toBe(second.id);
      expect(provider.createSandbox).toHaveBeenCalledTimes(1);
      expect(store.updateLastUsed).toHaveBeenCalled();
    });

    it("starts a stopped execution sandbox", async () => {
      const provider = createMockProvider();
      const store = createMockStore();
      const manager = new SandboxManagerImpl({ provider, store });

      const handle = await manager.ensureExecSandbox({
        projectId: "proj-1",
        commitSha: "abc123",
      });

      await provider.stopSandbox(handle.providerId);

      const restarted = await manager.ensureExecSandbox({
        projectId: "proj-1",
        commitSha: "abc123",
      });

      expect(restarted.status).toBe("started");
      expect(provider.startSandbox).toHaveBeenCalled();
    });

    it("creates separate sandboxes for different commits", async () => {
      const provider = createMockProvider();
      const store = createMockStore();
      const manager = new SandboxManagerImpl({ provider, store });

      const h1 = await manager.ensureExecSandbox({
        projectId: "proj-1",
        commitSha: "sha-1",
      });
      const h2 = await manager.ensureExecSandbox({
        projectId: "proj-1",
        commitSha: "sha-2",
      });

      expect(h1.id).not.toBe(h2.id);
      expect(provider.createSandbox).toHaveBeenCalledTimes(2);
    });
  });

  describe("ensureDevSandbox", () => {
    it("creates a new dev sandbox when none exists", async () => {
      const provider = createMockProvider();
      const store = createMockStore();
      const manager = new SandboxManagerImpl({ provider, store });

      const handle = await manager.ensureDevSandbox({
        projectId: "proj-1",
        userId: "user-1",
      });

      expect(handle.status).toBe("started");
      expect(handle.sandboxType).toBe("dev");
      expect(store.insertSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          sandboxType: "dev",
          commitSha: null,
          userId: "user-1",
        }),
      );
    });

    it("reuses an existing running dev sandbox", async () => {
      const provider = createMockProvider();
      const store = createMockStore();
      const manager = new SandboxManagerImpl({ provider, store });

      const first = await manager.ensureDevSandbox({
        projectId: "proj-1",
        userId: "user-1",
      });
      const second = await manager.ensureDevSandbox({
        projectId: "proj-1",
        userId: "user-1",
      });

      expect(first.id).toBe(second.id);
      expect(provider.createSandbox).toHaveBeenCalledTimes(1);
    });

    it("creates separate dev sandboxes for different users", async () => {
      const provider = createMockProvider();
      const store = createMockStore();
      const manager = new SandboxManagerImpl({ provider, store });

      const h1 = await manager.ensureDevSandbox({
        projectId: "proj-1",
        userId: "user-1",
      });
      const h2 = await manager.ensureDevSandbox({
        projectId: "proj-1",
        userId: "user-2",
      });

      expect(h1.id).not.toBe(h2.id);
      expect(provider.createSandbox).toHaveBeenCalledTimes(2);
    });

    it("dev sandbox has longer autoStopInterval than exec sandbox", async () => {
      const provider = createMockProvider();
      const store = createMockStore();
      const manager = new SandboxManagerImpl({ provider, store });

      await manager.ensureDevSandbox({ projectId: "p", userId: "u" });
      await manager.ensureExecSandbox({ projectId: "p", commitSha: "s" });

      const calls = (provider.createSandbox as ReturnType<typeof vi.fn>).mock
        .calls;
      const devCall = calls[0]![0] as CreateSandboxOpts;
      const execCall = calls[1]![0] as CreateSandboxOpts;
      expect(devCall.autoStopInterval).toBeGreaterThan(
        execCall.autoStopInterval!,
      );
    });
  });

  describe("releaseSandbox", () => {
    it("stops the sandbox via provider", async () => {
      const provider = createMockProvider();
      const store = createMockStore();
      const manager = new SandboxManagerImpl({ provider, store });

      await manager.releaseSandbox("some-sandbox-id");
      expect(provider.stopSandbox).toHaveBeenCalledWith("some-sandbox-id");
    });
  });
});
