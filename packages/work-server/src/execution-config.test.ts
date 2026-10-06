import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerNodesService } from "@catamorphic/core";
import { expect, it } from "vitest";
import {
  agentsReachMachine,
  type ExecutionProbes,
  executionSettingsFromEnv,
  machineCapabilities,
  resolveExecutionSettings,
  workExecution,
} from "./execution-config.js";
import { createWorkServer, SERVER_TENANT_ID } from "./server.js";
import { say, testServerOptions } from "./test-support.js";

const full = { hostSockets: true, netRaw: true };
const local = { WORK_SANDBOX: "local-process" } as const;

/** Probes for a machine with nothing but what the test says. */
const machine = (args: {
  kvm?: boolean;
  docker?: boolean;
  runsc?: { hostSockets: boolean; netRaw: boolean };
}): ExecutionProbes => ({
  microsandbox: () =>
    args.kvm
      ? { ok: true }
      : {
          ok: false,
          reason:
            "This machine has no usable /dev/kvm, so microsandbox cannot run here. Use WORK_SANDBOX=container (gVisor) or auto.",
        },
  container: async () =>
    args.docker
      ? {
          ok: true,
          ...(args.runsc
            ? { runsc: { kind: "runsc", name: "runsc", ...args.runsc } }
            : {}),
          runc: { name: "runc" },
        }
      : {
          ok: false,
          reason: "No Docker daemon answers at /var/run/docker.sock",
        },
});

it("rejects invalid budgets and subprocess resource guarantees before boot", () => {
  expect(() => executionSettingsFromEnv({ WORK_MAX_WORKSPACES: "0" })).toThrow(
    "positive integer",
  );
  expect(() =>
    executionSettingsFromEnv({ ...local, WORK_CAPACITY_MEMORY_MB: "1024" }),
  ).toThrow("require WORK_SANDBOX=microsandbox, container, or auto");
  expect(() =>
    executionSettingsFromEnv({
      WORK_SANDBOX: "microsandbox",
      WORK_WORKSPACE_CPU_MILLIS: "500",
    }),
  ).toThrow("whole cores");
  expect(() => executionSettingsFromEnv({ WORK_SANDBOX: "docker" })).toThrow(
    "auto, microsandbox, container, or local-process",
  );
  expect(() =>
    executionSettingsFromEnv({ ...local, WORK_CONTAINER_RUNTIME: "runsc" }),
  ).toThrow("apply to WORK_SANDBOX=container or auto");
  expect(() =>
    executionSettingsFromEnv({ WORK_CONTAINER_RUNTIME: "kata" }),
  ).toThrow("runsc or runc");
  expect(() =>
    executionSettingsFromEnv({ WORK_VOLUME_RETENTION_DAYS: "0" }),
  ).toThrow("WORK_VOLUME_RETENTION_DAYS must be a positive integer");
  expect(() => executionSettingsFromEnv({ DOCKER_HOST: "ssh://x" })).toThrow(
    "not supported",
  );
});

it("defaults to auto with budgets an isolated backend enforces (ADR 0204)", () => {
  const settings = executionSettingsFromEnv({
    WORK_CAPACITY_CPU_MILLIS: "4000",
    WORK_WORKSPACE_CPU_MILLIS: "500",
    WORK_VOLUME_RETENTION_DAYS: "7",
    DOCKER_HOST: "unix:///run/docker.sock",
    WORK_CONTAINER_PRIVILEGED: "1",
  });
  expect(settings).toMatchObject({
    backend: "auto",
    capacity: { cpuMillis: 4000 },
    defaults: { cpuMillis: 500, memoryMb: 1024 },
    explicitResources: true,
    volumeRetentionDays: 7,
    dockerHost: "unix:///run/docker.sock",
    privilegedContainers: true,
  });
  expect(executionSettingsFromEnv({}).volumeRetentionDays).toBe(30);
});

it("auto takes microsandbox, then gVisor, then runc, then local processes", async () => {
  const settings = executionSettingsFromEnv({ PATH: "/usr/bin" });
  const resolve = (probes: ExecutionProbes, env = {}) =>
    resolveExecutionSettings({
      settings: { ...settings, ...env },
      probes,
    });
  expect(
    await resolve(machine({ kvm: true, docker: true, runsc: full })),
  ).toMatchObject({
    backend: "microsandbox",
    reason: "auto: microsandbox can run on this machine",
  });
  const gvisor = await resolve(machine({ docker: true, runsc: full }));
  expect(gvisor).toMatchObject({
    backend: "container",
    containerRuntime: { kind: "runsc", name: "runsc" },
    capacity: { cpuMillis: expect.any(Number) },
  });
  expect(gvisor.reason).toBe(
    "auto: This machine has no usable /dev/kvm, so microsandbox cannot run here; containers run under gVisor (runsc)",
  );
  const limited = await resolve(
    machine({ docker: true, runsc: { hostSockets: false, netRaw: false } }),
  );
  expect(limited.reason).toContain("lacks --host-uds=open");
  expect(limited.reason).toContain("lacks --net-raw");
  const runc = await resolve(machine({ docker: true }));
  expect(runc).toMatchObject({
    backend: "container",
    containerRuntime: { kind: "runc", name: "runc" },
  });
  expect(runc.reason).toContain("no runsc runtime");
  // An operator who asks for runc gets it even beside gVisor.
  expect(
    await resolve(machine({ docker: true, runsc: full }), {
      containerRuntime: "runc",
    }),
  ).toMatchObject({ containerRuntime: { kind: "runc" } });
  const none = await resolve(machine({}));
  expect(none).toMatchObject({
    backend: "local-process",
    capacity: { workspaces: 8 },
    defaults: {},
  });
  expect(none.capacity.cpuMillis).toBeUndefined();
  expect(none.reason).toContain("No Docker daemon answers");
  // Budgets the fallback could not enforce stop the machine instead.
  await expect(
    resolveExecutionSettings({
      settings: executionSettingsFromEnv({ WORK_CAPACITY_MEMORY_MB: "2048" }),
      probes: machine({}),
    }),
  ).rejects.toThrow("CPU and memory limits need an isolated sandbox backend");
});

it("treats privileged runc containers as able to reach the machine (ADR 0204)", async () => {
  const resolved = (env: Record<string, string>, probes: ExecutionProbes) =>
    resolveExecutionSettings({
      settings: executionSettingsFromEnv(env),
      probes,
    });
  const dataDir = path.join(os.tmpdir(), "catamorphic-exec-config");
  const privileged = await resolved(
    { WORK_SANDBOX: "container", WORK_CONTAINER_PRIVILEGED: "1" },
    machine({ docker: true }),
  );
  expect(agentsReachMachine(privileged)).toBe(true);
  // It offers containers, and no egress policy a privileged one could leave.
  expect(
    workExecution({ settings: privileged, dataDir }).provider.capabilities,
  ).toEqual(["images", "images.build", "containers", "volumes"]);
  expect(
    agentsReachMachine(
      await resolved({ WORK_SANDBOX: "container" }, machine({ docker: true })),
    ),
  ).toBe(false);
  // gVisor needs no privilege, whatever the operator accepted.
  expect(
    agentsReachMachine(
      await resolved(
        { WORK_SANDBOX: "container", WORK_CONTAINER_PRIVILEGED: "1" },
        machine({ docker: true, runsc: full }),
      ),
    ),
  ).toBe(false);
  expect(agentsReachMachine(await resolved(local, machine({})))).toBe(true);
  expect(
    executionSettingsFromEnv({ WORK_SANDBOX_PIDS_LIMIT: "512" }).pidsLimit,
  ).toBe(512);
  expect(() =>
    executionSettingsFromEnv({ ...local, WORK_SANDBOX_PIDS_LIMIT: "512" }),
  ).toThrow("apply to WORK_SANDBOX=container or auto");
});

it("an explicit backend that cannot run refuses with the fix", async () => {
  await expect(
    resolveExecutionSettings({
      settings: executionSettingsFromEnv({ WORK_SANDBOX: "microsandbox" }),
      probes: machine({ docker: true, runsc: full }),
    }),
  ).rejects.toThrow(
    "This machine has no usable /dev/kvm, so microsandbox cannot run here. Use WORK_SANDBOX=container (gVisor) or auto.",
  );
  await expect(
    resolveExecutionSettings({
      settings: executionSettingsFromEnv({ WORK_SANDBOX: "container" }),
      probes: machine({}),
    }),
  ).rejects.toThrow("so the container backend cannot run here");
  await expect(
    resolveExecutionSettings({
      settings: executionSettingsFromEnv({
        WORK_SANDBOX: "container",
        WORK_CONTAINER_RUNTIME: "runsc",
      }),
      probes: machine({ docker: true }),
    }),
  ).rejects.toThrow("no runsc (gVisor) runtime");
  expect(
    await resolveExecutionSettings({
      settings: executionSettingsFromEnv({ WORK_SANDBOX: "local-process" }),
      probes: machine({}),
    }),
  ).toMatchObject({
    backend: "local-process",
    reason: "WORK_SANDBOX=local-process",
  });
});

it("configures images, containers and unenforced egress per backend (ADR 0176)", async () => {
  const micro = await resolveExecutionSettings({
    settings: executionSettingsFromEnv({
      WORK_SANDBOX: "microsandbox",
      WORK_IMAGE_BUILDER: "podman",
    }),
    probes: machine({ kvm: true }),
  });
  expect(micro).toMatchObject({
    images: { builder: "podman" },
    containers: true,
  });
  const dataDir = path.join(os.tmpdir(), "catamorphic-exec-config");
  expect(
    workExecution({ settings: micro, dataDir }).provider.capabilities,
  ).toEqual([
    "images",
    "network.policy",
    "containers",
    "images.build",
    "volumes",
  ]);
  expect(
    executionSettingsFromEnv({
      WORK_SANDBOX: "microsandbox",
      WORK_SANDBOX_CONTAINERS: "0",
    }).containers,
  ).toBe(false);
  const gvisor = workExecution({
    settings: await resolveExecutionSettings({
      settings: executionSettingsFromEnv({ WORK_SANDBOX: "container" }),
      probes: machine({ docker: true, runsc: full }),
    }),
    dataDir,
  });
  expect(gvisor.provider.capabilities).toEqual([
    "images",
    "images.build",
    "network.policy",
    "containers",
    "volumes",
  ]);
  expect(gvisor.isolation).toBe("sandbox");
  expect(gvisor.backend).toMatchObject({ kind: "container", runtime: "runsc" });
  const runc = workExecution({
    settings: await resolveExecutionSettings({
      settings: executionSettingsFromEnv({ WORK_SANDBOX: "container" }),
      probes: machine({ docker: true }),
    }),
    dataDir,
  });
  // Nested Docker under runc only with the operator's acceptance.
  expect(runc.provider.capabilities).toEqual([
    "images",
    "images.build",
    "network.policy",
    "volumes",
  ]);
  expect(runc.isolation).toBe("process");
  const localSettings = await resolveExecutionSettings({
    settings: executionSettingsFromEnv({
      ...local,
      WORK_DOCKER_SOCKET: "/var/run/docker.sock",
      WORK_UNENFORCED_EGRESS: "accept",
    }),
  });
  expect(
    workExecution({ settings: localSettings, dataDir }).provider.capabilities,
  ).toEqual(["containers", "network.policy", "volumes"]);
  // A plain local-process machine offers only volumes under ~.
  expect(
    workExecution({
      settings: await resolveExecutionSettings({
        settings: executionSettingsFromEnv(local),
      }),
      dataDir,
    }).provider.capabilities,
  ).toEqual(["volumes"]);
  for (const [env, message] of [
    [
      { ...local, WORK_IMAGE_BUILDER: "docker" },
      "requires WORK_SANDBOX=microsandbox",
    ],
    [
      { WORK_SANDBOX: "container", WORK_IMAGE_BUILDER: "docker" },
      "builds images with its own Docker daemon",
    ],
    [
      { WORK_SANDBOX: "microsandbox", WORK_IMAGE_BUILDER: "kaniko" },
      "docker or podman",
    ],
    [
      { WORK_SANDBOX: "microsandbox", WORK_DOCKER_SOCKET: "/x.sock" },
      "microsandbox runs Docker inside each VM",
    ],
    [
      { WORK_SANDBOX: "container", WORK_DOCKER_SOCKET: "/x.sock" },
      "set DOCKER_HOST",
    ],
    [
      { WORK_SANDBOX: "microsandbox", WORK_UNENFORCED_EGRESS: "accept" },
      "local-process only",
    ],
    [{ WORK_UNENFORCED_EGRESS: "yes" }, "must be accept"],
    [{ WORK_PERSONAL_CREDENTIALS: "yes" }, "must be accept"],
    [
      { WORK_SANDBOX: "microsandbox", WORK_PERSONAL_CREDENTIALS: "accept" },
      "microsandbox gives each chat its own VM",
    ],
  ] as const)
    expect(() => executionSettingsFromEnv(env)).toThrow(message);
});

it("advertises accepted personal credentials and the harness CLIs on its path (ADR 0184)", async () => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-bin-"));
  try {
    await fs.writeFile(path.join(bin, "claude"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    // Not executable: not a CLI.
    await fs.writeFile(path.join(bin, "codex"), "", { mode: 0o644 });
    const resolved = (env: Record<string, string>, probes = machine({})) =>
      resolveExecutionSettings({
        settings: executionSettingsFromEnv({ PATH: bin, ...env }),
        probes,
      });
    const settings = await resolved({
      ...local,
      WORK_PERSONAL_CREDENTIALS: "accept",
    });
    expect(settings.acceptPersonalCredentials).toBe(true);
    expect(machineCapabilities(settings)).toEqual([
      "credentials.personal",
      "harness.claude-code",
    ]);
    expect(machineCapabilities(await resolved(local))).toEqual([
      "harness.claude-code",
    ]);
    // A VM or a gVisor container gets its CLIs from the Environment's image.
    expect(
      machineCapabilities(
        await resolved(
          { WORK_SANDBOX: "microsandbox" },
          machine({ kvm: true }),
        ),
      ),
    ).toEqual([]);
    expect(
      machineCapabilities(
        await resolved(
          { WORK_SANDBOX: "container", WORK_PERSONAL_CREDENTIALS: "accept" },
          machine({ docker: true, runsc: full }),
        ),
      ),
    ).toEqual([]);
    // runc containers are process isolation, as local processes are.
    expect(
      machineCapabilities(
        await resolved(
          { WORK_SANDBOX: "container", WORK_PERSONAL_CREDENTIALS: "accept" },
          machine({ docker: true }),
        ),
      ),
    ).toEqual(["credentials.personal"]);
  } finally {
    await fs.rm(bin, { recursive: true, force: true });
  }
});

it("a full managed machine preserves existing work and restores an archived session with fresh capacity", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "catamorphic-capacity-"),
  );
  const server = await createWorkServer(
    testServerOptions({
      dataDir,
      env: {
        DATABASE_URL: "",
        WORK_FAKE_AGENT: "1",
        WORK_MAX_WORKSPACES: "1",
        PATH: process.env.PATH,
      },
    }),
  );
  try {
    const core = server.catamorphic.core;
    const identity = {
      tenantId: SERVER_TENANT_ID,
      externalUserId: "capacity-member",
    };
    const project = await core.projects.create(identity, {
      name: "Development",
    });
    const sessions = core.agentSessions;
    if (!sessions) throw Error("Missing sessions");
    const first = await sessions.create(identity, project.id, {
      agentId: "assistant",
      environment: "default",
    });
    await expect(
      sessions.create(identity, project.id, {
        agentId: "assistant",
        environment: "default",
      }),
    ).rejects.toThrow("no workspace capacity");
    await expect(
      say({
        sessions,
        identity,
        projectId: project.id,
        sessionId: first.id,
        text: "still works",
      }),
    ).resolves.toMatchObject({ content: "Echo: still works" });
    const originalAllocation = first.allocationId;
    await sessions.archive(identity, project.id, first.id);
    await expect
      .poll(
        async () => {
          const row = await core.db
            .selectFrom("execution_allocations")
            .select("capacity_released_at")
            .where("id", "=", originalAllocation ?? "")
            .executeTakeFirst();
          return Boolean(row?.capacity_released_at);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const restored = await sessions.unarchive(identity, project.id, first.id);
    expect(restored[0]?.allocationId).not.toBe(originalAllocation);
    await expect(
      say({
        sessions,
        identity,
        projectId: project.id,
        sessionId: first.id,
        text: "restored",
      }),
    ).resolves.toMatchObject({ content: "Echo: restored (turn 2)" });
    const nodes = new WorkerNodesService(core.db);
    const health = (
      await server.app.inject({ method: "GET", url: "/healthz" })
    ).json();
    const node = await core.db
      .selectFrom("worker_nodes")
      .select("authority_id")
      .where("id", "=", health.machine.id)
      .executeTakeFirstOrThrow();
    const inventory = await nodes.workspaces({
      tenantId: SERVER_TENANT_ID,
      authorityId: node.authority_id,
      nodeId: health.machine.id,
    });
    expect(inventory).toHaveLength(1);
  } finally {
    await server.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);

it("a shared control plane refuses to run agent code as its own subprocess", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-guard-"));
  try {
    await expect(
      createWorkServer(
        testServerOptions({
          dataDir,
          env: {
            // Never contacted: the execution policy is checked first.
            DATABASE_URL: "postgres://127.0.0.1:1/unreachable",
            WORK_SECRET: "execution-guard-secret-with-at-least-32-chars",
            WORK_OPERATOR_SECRET: "execution-guard-operator-with-32-chars",
            WORK_VAULT_KEY: Buffer.alloc(32, 3).toString("base64"),
            WORK_FAKE_AGENT: "1",
            PATH: process.env.PATH,
          },
        }),
      ),
    ).rejects.toThrow(/microsandbox.*enroll workers/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
