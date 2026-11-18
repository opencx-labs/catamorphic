import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContainerSandboxProvider, DockerClient } from "@catamorphic/container";
import { MACHINE_CAPABILITIES } from "@catamorphic/sandbox";
import { afterAll, describe, expect, it } from "vitest";
import { WorkerOfferSchema } from "./worker-registry.js";

/**
 * A worker states what its provider offers when it connects (ADR 0192).
 * The control plane must accept every name a real provider lists, or the
 * machine never connects: a container machine under gVisor with host
 * sockets and raw networking offers all of the container backend's
 * capabilities, separated commands (ADR 0332) and caches (ADR 0334)
 * included.
 */
describe("worker offers", () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "work-offer-"));
  afterAll(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));

  it("accept every capability the container backend offers", () => {
    const provider = new ContainerSandboxProvider({
      // Nothing is asked of the daemon to list capabilities.
      docker: new DockerClient({
        socketPath: path.join(stateDirectory, "absent.sock"),
      }),
      runtime: {
        kind: "runsc",
        name: "runsc",
        hostSockets: true,
        netRaw: true,
      },
      stateDirectory,
    });
    expect(provider.capabilities).toEqual(
      expect.arrayContaining(["caches", "commands.separate"]),
    );
    const parsed = WorkerOfferSchema.safeParse({
      isolation: provider.isolation,
      resourceLimits: [...provider.resourceLimits],
      workspaceRoot: provider.workspaceRoot,
      processes: true,
      capabilities: [
        ...provider.capabilities,
        ...Object.values(MACHINE_CAPABILITIES),
        "sign-in:codex:ada@example.com",
      ],
      capacity: { workspaces: 4, cpuMillis: 4000, memoryMb: 8192 },
      defaults: { cpuMillis: 1000, memoryMb: 1024 },
    });
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it("still refuse a name no provider offers", () => {
    const parsed = WorkerOfferSchema.safeParse({
      isolation: "sandbox",
      workspaceRoot: "/workspace",
      capabilities: ["root.everything"],
      capacity: { workspaces: 1 },
    });
    expect(parsed.success).toBe(false);
  });
});
