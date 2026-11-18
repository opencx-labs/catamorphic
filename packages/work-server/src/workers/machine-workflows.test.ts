import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkerNodesService } from "@catamorphic/core";
import { generateExecutorKeyPair } from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { testServerOptions } from "../test-support.js";
import { installTarget } from "./install-script.js";
import type { MachineClass } from "./machine-classes.js";
import {
  MachineProvisioningRefusedError,
  MachineReconciler,
  type MachineWorkflowRun,
  type MachineWorkflows,
  sharedName,
} from "./machine-rules.js";
import { WorkerOfferSchema, WorkWorkerRegistry } from "./worker-registry.js";

/**
 * Machine provisioners as workflows (ADR 0327): the reconciler starts a
 * `workflow` class's create run once per enrollment, reads its answer on
 * later passes, and asks destroy until it is done. A fake stands in for
 * the project's workflows and records what was started; machines enroll
 * and connect through the registry, as a worker does.
 */
const PROVISIONER = "0f6a2c55-5b0b-4d64-9b4a-6c1f5a1f4f0e";
const ENG = "eng@example.com";
/** Where machines reach the control plane: never a loopback address. */
const PUBLIC = "https://brain.example.test";
const OPTIONS = { region: "eu-west-1", instanceType: "r7i.2xlarge" };
const classes: Record<string, MachineClass> = {
  fleet: {
    platform: "workflow",
    project: PROVISIONER,
    create: "createMachine",
    destroy: "destroyMachine",
    options: OPTIONS,
    sandbox: "container",
  },
};

const CreateInput = z.object({
  name: z.string(),
  class: z.string(),
  rule: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
  labels: z.record(z.string(), z.string()),
  enrollment: z.object({
    controlPlaneUrl: z.string(),
    code: z.string(),
    idempotencyKey: z.string(),
    cloudInit: z.string().optional(),
  }),
});

type Started = Parameters<MachineWorkflows["start"]>[0];

/** The project's workflows, as the reconciler sees them. */
class FakeWorkflows implements MachineWorkflows {
  started: Started[] = [];
  runs = new Map<string, MachineWorkflowRun>();
  events: Array<Parameters<MachineWorkflows["record"]>[0]> = [];
  /** Why the project would start nothing, when set. */
  refuse: string | undefined;
  /** A start that fails before it stores a run. */
  lost: string | undefined;
  /** A start that fails after its run began. */
  lostAfterStart: string | undefined;
  canceled: string[] = [];

  async start(args: Started) {
    if (this.refuse) throw new MachineProvisioningRefusedError(this.refuse);
    if (this.lost) throw new Error(this.lost);
    this.started.push(args);
    this.runs.set(args.correlationKey, { status: "active", ageMs: 0 });
    if (this.lostAfterStart) throw new Error(this.lostAfterStart);
  }

  async latest(args: { correlationKey: string }) {
    return this.runs.get(args.correlationKey);
  }

  async cancel(args: { correlationKey: string }) {
    this.canceled.push(args.correlationKey);
    this.fail(args.correlationKey, "canceled");
  }

  fail(correlationKey: string, error: string, endedForMs = 0) {
    const previous = this.runs.get(correlationKey);
    this.runs.set(correlationKey, {
      status: "failed",
      error,
      endedForMs,
      failures: (previous?.status === "failed" ? previous.failures : 0) + 1,
    });
  }

  /** Recordings that fail before one lands. */
  failRecords = 0;

  async record(args: Parameters<MachineWorkflows["record"]>[0]) {
    if (this.failRecords > 0) {
      this.failRecords -= 1;
      throw new Error("The project's event log did not answer");
    }
    // As the project's event log: one event per external id.
    if (
      this.events.some(
        (event) => event.event.externalId === args.event.externalId,
      )
    )
      return;
    this.events.push(args);
  }

  creates(name?: string) {
    return this.started
      .filter((start) => start.kind === "machine.create")
      .map((start) => ({ ...start, input: CreateInput.parse(start.input) }))
      .filter((start) => !name || start.input.name === name);
  }

  destroys() {
    return this.started.filter((start) => start.kind === "machine.destroy");
  }

  answer(correlationKey: string, output: unknown) {
    this.runs.set(correlationKey, { status: "completed", output });
  }

  kinds(name: string) {
    return this.events
      .filter((event) => event.event.payload.name === name)
      .map((event) => event.event.kind);
  }
}

let root: string;
let server: WorkServer;
let authorityId: string;

const db = () => server.catamorphic.core.db;

function setup(options: { now?: () => number } = {}) {
  const workflows = new FakeWorkflows();
  const reconciler: MachineReconciler = new MachineReconciler({
    db: db(),
    tenantId: SERVER_TENANT_ID,
    workers: registry(),
    classes,
    workflows,
    ...(options.now ? { now: options.now } : {}),
    install: installTarget({
      publicBase: PUBLIC,
      workerImage: "ghcr.io/acme/work-server:test",
    }),
    controlPlaneUrl: PUBLIC,
    emailOf: async () => undefined,
  });
  // Machines' first calls and disk episodes reach this reconciler, as the
  // server wires it.
  const workers = registry(
    (machine) => reconciler.machineConnected(machine),
    (machine) => reconciler.machineDiskLow(machine),
  );
  /** One pass of this reconciler, once another's is out of the way. */
  const pass = async () => {
    for (;;) {
      const summary = await reconciler.reconcile();
      if (!summary.busy) return summary;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { workflows, reconciler, workers, pass };
}

function registry(
  firstContact?: ConstructorParameters<
    typeof WorkWorkerRegistry
  >[0]["firstContact"],
  diskLow?: ConstructorParameters<typeof WorkWorkerRegistry>[0]["diskLow"],
) {
  return new WorkWorkerRegistry({
    db: db(),
    nodes: new WorkerNodesService(db()),
    tenantId: SERVER_TENANT_ID,
    authorityId,
    ...(firstContact ? { firstContact } : {}),
    ...(diskLow ? { diskLow } : {}),
  });
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function machine(name: string) {
  return (await registry().machines()).find(
    (candidate) => candidate.name === name,
  );
}

/** A worker process's epoch: a UUIDv7 (ADR 0192). */
function epoch(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes.writeUInt8(((bytes.readUInt8(6) & 0x0f) | 0x70) >>> 0, 6);
  bytes.writeUInt8(((bytes.readUInt8(8) & 0x3f) | 0x80) >>> 0, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The created machine enrolls with its code, and its worker connects. */
async function enroll(args: {
  workers: WorkWorkerRegistry;
  name: string;
  code: string;
  connect?: boolean;
}): Promise<{ nodeId: string; session: string }> {
  const { publicKey } = generateExecutorKeyPair();
  const { nodeId } = await args.workers.enroll({ code: args.code, publicKey });
  const session = epoch();
  if (args.connect)
    await args.workers.connect({
      nodeId,
      name: args.name,
      session,
      offer: WorkerOfferSchema.parse({
        isolation: "sandbox",
        workspaceRoot: "/workspaces",
        capacity: { workspaces: 1 },
      }),
      publicKey,
    });
  return { nodeId, session };
}

const shared = (rule: string) => ({
  name: rule,
  rule: {
    group: ENG,
    machines: { shared: 1 },
    class: "fleet",
    retainDays: 0,
  },
});

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-machine-workflows-"));
  const dataDir = path.join(root, "control-plane");
  server = await createWorkServer(
    testServerOptions({
      dataDir,
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        PATH: process.env.PATH,
      },
    }),
  );
  authorityId = fs.readFileSync(path.join(dataDir, "host-id"), "utf8").trim();
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

// Each case starts with no rules and no machines of earlier ones.
beforeEach(async () => {
  await sql`DELETE FROM work_machine_rules`.execute(db());
  await sql`DELETE FROM work_worker_enrollments`.execute(db());
  await sql`DELETE FROM work_workers`.execute(db());
});

describe("workflow machine classes (ADR 0327)", () => {
  it("starts one create run per enrollment and records the ref it returns", async () => {
    const { workflows, reconciler, workers, pass } = setup();
    await reconciler.setRule(shared("fleet-a"));
    const name = sharedName("fleet-a", "fleet", ENG, 1);
    for (let index = 0; index < 3; index += 1) await pass();
    const [start, ...more] = workflows.creates(name);
    if (!start) throw new Error("No create was started");
    expect(more).toEqual([]);
    expect(start).toMatchObject({
      project: PROVISIONER,
      workflow: "createMachine",
      kind: "machine.create",
    });
    // What the custom hook receives, with the class's options unread.
    const { enrollment } = start.input;
    expect(start.input).toMatchObject({
      name,
      class: "fleet",
      rule: "fleet-a",
      options: OPTIONS,
      labels: { class: "fleet" },
    });
    expect(enrollment.controlPlaneUrl).toBe(PUBLIC);
    expect(enrollment.idempotencyKey).toBe(sha256(enrollment.code));
    expect(enrollment.cloudInit).toContain(
      `"--code", "${enrollment.code}", "--sandbox", "container"`,
    );
    expect(start.correlationKey).toBe(
      `machine-create:${enrollment.idempotencyKey}`,
    );
    // Intent is recorded before the run starts.
    expect(await machine(name)).toMatchObject({
      state: "pending",
      ref: `creating:${enrollment.idempotencyKey}`,
    });
    // The machine enrolls before its run answers; the ref still lands.
    await enroll({ workers, name, code: enrollment.code });
    workflows.answer(start.correlationKey, { ref: "i-0aaa" });
    const summary = await pass();
    expect(summary.created).toEqual([name]);
    expect(await machine(name)).toMatchObject({
      state: "enrolled",
      ref: "i-0aaa",
    });
    expect(workflows.events).toEqual([
      {
        project: PROVISIONER,
        event: expect.objectContaining({
          source: "machines",
          kind: "machine.created",
          payload: { name, class: "fleet", rule: "fleet-a", ref: "i-0aaa" },
        }),
      },
    ]);
    await pass();
    expect(workflows.creates(name)).toHaveLength(1);
    await reconciler.deleteRule("fleet-a");
  });

  it("withdraws the code of a refused create, and the next pass tries again", async () => {
    const { workflows, reconciler, pass } = setup();
    await reconciler.setRule(shared("fleet-b"));
    const name = sharedName("fleet-b", "fleet", ENG, 1);
    await pass();
    const [first] = workflows.creates(name);
    if (!first) throw new Error("No create was started");
    workflows.answer(first.correlationKey, {
      refused: "InsufficientInstanceCapacity",
    });
    const summary = await pass();
    expect(summary.failed).toEqual([
      expect.objectContaining({
        name,
        rule: "fleet-b",
        error: expect.stringContaining("InsufficientInstanceCapacity"),
      }),
    ]);
    expect(summary.created).toEqual([]);
    expect(await machine(name)).toBeUndefined();
    await pass();
    const [, second] = workflows.creates(name);
    expect(second?.input.enrollment.idempotencyKey).not.toBe(
      first.input.enrollment.idempotencyKey,
    );
    expect(workflows.events).toEqual([]);
    await reconciler.deleteRule("fleet-b");
  });

  it("refuses a create when the project has no automation turned on", async () => {
    const { workflows, reconciler, pass } = setup();
    workflows.refuse = `Project ${PROVISIONER} has no automation createMachine bound to machine.create turned on for the project`;
    await reconciler.setRule(shared("fleet-c"));
    const name = sharedName("fleet-c", "fleet", ENG, 1);
    const summary = await pass();
    expect(summary.failed).toEqual([
      expect.objectContaining({
        name,
        error: expect.stringContaining("no automation createMachine"),
      }),
    ]);
    expect(await machine(name)).toBeUndefined();
    expect((await reconciler.status())["fleet-c"]?.failure?.error).toContain(
      "turned on for the project",
    );
    await reconciler.deleteRule("fleet-c");
  });

  it("tries again at once when a start stored no run", async () => {
    const { workflows, reconciler, pass } = setup();
    workflows.lost = "TenantActiveRunLimitError: too many runs";
    await reconciler.setRule(shared("fleet-h"));
    const name = sharedName("fleet-h", "fleet", ENG, 1);
    expect((await pass()).failed).toEqual([
      expect.objectContaining({
        name,
        error: expect.stringContaining("did not start"),
      }),
    ]);
    // Nothing ran: the code is withdrawn instead of waiting enrollMinutes.
    expect(await machine(name)).toBeUndefined();
    workflows.lost = undefined;
    await pass();
    expect(workflows.creates(name)).toHaveLength(1);
  });

  it("keeps the code when the start failed after its run began", async () => {
    const { workflows, reconciler, pass } = setup();
    workflows.lostAfterStart = "connection reset";
    await reconciler.setRule(shared("fleet-i"));
    const name = sharedName("fleet-i", "fleet", ENG, 1);
    expect((await pass()).failed).toEqual([]);
    const [create] = workflows.creates(name);
    expect(await machine(name)).toMatchObject({
      state: "pending",
      ref: `creating:${create?.input.enrollment.idempotencyKey}`,
    });
  });

  it("withdraws a code whose run was never stored once no pass can still be starting it", async () => {
    const { workflows, reconciler, pass } = setup();
    await reconciler.setRule(shared("fleet-j"));
    const name = sharedName("fleet-j", "fleet", ENG, 1);
    await pass();
    const [create] = workflows.creates(name);
    if (!create) throw new Error("No create was started");
    // The pass that started it ended before its run was stored.
    workflows.runs.delete(create.correlationKey);
    expect((await pass()).failed).toEqual([]);
    expect((await machine(name))?.state).toBe("pending");
    await sql`
      UPDATE work_worker_enrollments
      SET created_at = created_at - interval '5 minutes'
      WHERE name = ${name}
    `.execute(db());
    expect((await pass()).failed).toEqual([
      expect.objectContaining({
        name,
        error: expect.stringContaining("never started"),
      }),
    ]);
    expect(await machine(name)).toBeUndefined();
  });

  it("backs off a platform that keeps refusing", async () => {
    let clock = Date.now();
    const { workflows, reconciler, pass } = setup({ now: () => clock });
    await reconciler.setRule(shared("fleet-k"));
    const name = sharedName("fleet-k", "fleet", ENG, 1);
    const refuseLatest = () => {
      const latest = workflows.creates(name).at(-1);
      if (!latest) throw new Error("No create was started");
      workflows.answer(latest.correlationKey, { refused: "VcpuLimitExceeded" });
    };
    await pass();
    refuseLatest();
    await pass();
    // A first refusal tries again on the next pass.
    await pass();
    expect(workflows.creates(name)).toHaveLength(2);
    refuseLatest();
    await pass();
    // A second waits a minute, and says so.
    expect((await pass()).failed).toEqual([
      expect.objectContaining({
        name,
        error: expect.stringContaining("refused this machine 2 times"),
      }),
    ]);
    expect(workflows.creates(name)).toHaveLength(2);
    clock += 61_000;
    await pass();
    expect(workflows.creates(name)).toHaveLength(3);
  });

  it("treats a failed create as uncertain and asks destroy until it is done", async () => {
    const { workflows, reconciler, pass } = setup();
    await reconciler.setRule(shared("fleet-d"));
    const name = sharedName("fleet-d", "fleet", ENG, 1);
    await pass();
    const [create] = workflows.creates(name);
    if (!create) throw new Error("No create was started");
    const key = create.input.enrollment.idempotencyKey;
    workflows.fail(create.correlationKey, "RequestTimeout");
    const failed = await pass();
    expect(failed.failed).toEqual([
      expect.objectContaining({
        name,
        error: expect.stringContaining("RequestTimeout"),
      }),
    ]);
    // The machine may still enroll: its code stays, reported once.
    expect(await machine(name)).toMatchObject({
      state: "pending",
      ref: `unknown:${key}`,
    });
    expect((await pass()).failed).toEqual([]);
    expect(workflows.creates(name)).toHaveLength(1);

    await reconciler.deleteRule("fleet-d");
    await pass();
    const [destroy] = workflows.destroys();
    expect(destroy).toEqual({
      project: PROVISIONER,
      workflow: "destroyMachine",
      kind: "machine.destroy",
      // No ref is known: destroy finds the machine by its name and the
      // key it was launched with.
      input: {
        name,
        class: "fleet",
        rule: "fleet-d",
        ref: null,
        idempotencyKey: key,
        requestedAt: expect.any(String),
        options: OPTIONS,
      },
      correlationKey: `machine-destroy:${name}:unknown:${key}`,
    });
    if (!destroy) throw new Error("No destroy was started");
    // One destroy at a time.
    expect((await pass()).destroying).toEqual([name]);
    expect(workflows.destroys()).toHaveLength(1);
    workflows.answer(destroy.correlationKey, { done: false });
    await pass();
    expect(workflows.destroys()).toHaveLength(2);
    workflows.answer(destroy.correlationKey, { done: true });
    expect((await pass()).removed).toEqual([name]);
    expect(await machine(name)).toBeUndefined();
    expect(workflows.kinds(name)).toEqual(["machine.destroyed"]);
  });

  it("backs off a destroy that keeps failing", async () => {
    const { workflows, reconciler, pass } = setup();
    await reconciler.setRule(shared("fleet-l"));
    const name = sharedName("fleet-l", "fleet", ENG, 1);
    await pass();
    const [create] = workflows.creates(name);
    if (!create) throw new Error("No create was started");
    workflows.answer(create.correlationKey, { ref: "i-0lll" });
    await pass();
    await reconciler.deleteRule("fleet-l");
    await pass();
    const [destroy] = workflows.destroys();
    if (!destroy) throw new Error("No destroy was started");
    workflows.fail(destroy.correlationKey, "UnauthorizedOperation");
    expect((await pass()).failed).toEqual([
      expect.objectContaining({
        name,
        error: expect.stringContaining("runs again in 1 minutes"),
      }),
    ]);
    expect(workflows.destroys()).toHaveLength(1);
    workflows.fail(destroy.correlationKey, "UnauthorizedOperation", 0);
    workflows.fail(destroy.correlationKey, "UnauthorizedOperation", 121_000);
    // Three failures: it waits four minutes after the latest.
    await pass();
    expect(workflows.destroys()).toHaveLength(1);
    workflows.runs.set(destroy.correlationKey, {
      status: "failed",
      error: "UnauthorizedOperation",
      endedForMs: 5 * 60_000,
      failures: 3,
    });
    await pass();
    expect(workflows.destroys()).toHaveLength(2);
  });

  it("cancels a create run that never finishes, and destroys the machine by name", async () => {
    let clock = Date.now();
    const { workflows, reconciler, pass } = setup({ now: () => clock });
    await reconciler.setRule(shared("fleet-m"));
    const name = sharedName("fleet-m", "fleet", ENG, 1);
    await pass();
    const [create] = workflows.creates(name);
    if (!create) throw new Error("No create was started");
    const key = create.input.enrollment.idempotencyKey;
    await reconciler.deleteRule("fleet-m");
    // A create run paused or stuck retrying for 31 minutes.
    clock += 31 * 60_000;
    workflows.runs.set(create.correlationKey, {
      status: "active",
      ageMs: 31 * 60_000,
    });
    await pass();
    expect(workflows.canceled).toEqual([create.correlationKey]);
    // It may have launched until it was canceled: destroy's grace for a
    // late listing counts from then, not from the enrollment.
    const [stuckDestroy] = workflows.destroys();
    expect(
      Date.parse(String(stuckDestroy?.input.requestedAt)),
    ).toBeGreaterThanOrEqual(clock);
    expect(workflows.destroys()).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({ ref: null, idempotencyKey: key }),
        correlationKey: `machine-destroy:${name}:unknown:${key}`,
      }),
    ]);
  });

  it("waits for a create still running before destroying what it made", async () => {
    const { workflows, reconciler, pass } = setup();
    await reconciler.setRule(shared("fleet-e"));
    const name = sharedName("fleet-e", "fleet", ENG, 1);
    await pass();
    const [create] = workflows.creates(name);
    if (!create) throw new Error("No create was started");
    await reconciler.deleteRule("fleet-e");
    expect((await pass()).destroying).toEqual([name]);
    expect(workflows.destroys()).toEqual([]);
    workflows.answer(create.correlationKey, { ref: "i-0eee" });
    await pass();
    const [destroy] = workflows.destroys();
    expect(destroy).toMatchObject({
      input: { name, ref: "i-0eee" },
      correlationKey: `machine-destroy:${name}:i-0eee`,
    });
    if (!destroy) throw new Error("No destroy was started");
    workflows.answer(destroy.correlationKey, { done: true });
    expect((await pass()).removed).toEqual([name]);
    // Its answer was first read by destroy, and still told the project.
    expect(workflows.kinds(name)).toEqual([
      "machine.created",
      "machine.destroyed",
    ]);
  });

  it("tells the provisioner's project when a machine connects, is released and is destroyed", async () => {
    const { workflows, reconciler, workers, pass } = setup();
    await reconciler.setRule(shared("fleet-f"));
    const name = sharedName("fleet-f", "fleet", ENG, 1);
    await pass();
    const [create] = workflows.creates(name);
    if (!create) throw new Error("No create was started");
    workflows.answer(create.correlationKey, { ref: "i-0fff" });
    await pass();
    await enroll({
      workers,
      name,
      code: create.input.enrollment.code,
      connect: true,
    });
    expect(workflows.kinds(name)).toEqual([
      "machine.created",
      "machine.connected",
    ]);
    await reconciler.deleteRule("fleet-f");
    await pass();
    const [destroy] = workflows.destroys();
    if (!destroy) throw new Error("No destroy was started");
    workflows.answer(destroy.correlationKey, { done: true });
    await pass();
    expect(workflows.kinds(name)).toEqual([
      "machine.created",
      "machine.connected",
      "machine.released",
      "machine.destroyed",
    ]);
    for (const event of workflows.events)
      expect(event.event.payload).toEqual({
        name,
        class: "fleet",
        rule: "fleet-f",
        ref: "i-0fff",
      });
  });

  it("tells it when a machine on demand is lost", async () => {
    const { workflows, reconciler, workers, pass } = setup();
    await reconciler.setRule({
      name: "fleet-g",
      rule: {
        group: ENG,
        machines: { demand: { max: 1, min: 1, enrollMinutes: 1 } },
        class: "fleet",
        trusted: true,
      },
    });
    await pass();
    const [create] = workflows.creates();
    if (!create) throw new Error("No create was started");
    const { name } = create.input;
    workflows.answer(create.correlationKey, { ref: "i-0ggg" });
    await pass();
    await enroll({ workers, name, code: create.input.enrollment.code });
    // It never calls in its enrollMinutes.
    await sql`
      UPDATE work_workers
      SET enrolled_at = enrolled_at - interval '2 minutes'
      WHERE name = ${name}
    `.execute(db());
    await pass();
    expect(workflows.kinds(name)).toEqual([
      "machine.created",
      "machine.lost",
      "machine.released",
    ]);
    await reconciler.deleteRule("fleet-g");
  });

  it("tells it once per episode when a machine falls under its disk floor, with its report and the class's options (ADR 0335)", async () => {
    const { workflows, reconciler, workers, pass } = setup();
    await reconciler.setRule(shared("fleet-k"));
    const name = sharedName("fleet-k", "fleet", ENG, 1);
    await pass();
    const [create] = workflows.creates(name);
    if (!create) throw new Error("No create was started");
    workflows.answer(create.correlationKey, { ref: "i-0ddd" });
    await pass();
    const { nodeId, session } = await enroll({
      workers,
      name,
      code: create.input.enrollment.code,
      connect: true,
    });
    const disk = (free: number) => ({
      path: "/var/lib/work-worker",
      totalBytes: 100e9,
      freeBytes: free,
      floorBytes: 10e9,
      criticalBytes: 1e9,
      measuredAt: new Date().toISOString(),
    });
    const lowEvents = () =>
      workflows.events.filter(
        (event) => event.event.kind === "machine.disk-low",
      );
    await workers.renew({ nodeId, session, disk: disk(50e9) });
    expect(lowEvents()).toEqual([]);
    // The first recording fails: the next report in the episode records it.
    workflows.failRecords = 1;
    await workers.renew({ nodeId, session, disk: disk(4e9) });
    expect(lowEvents()).toEqual([]);
    // Every replica hears its renewals; the episode is told once.
    await Promise.all(
      [1, 2, 3].map(() => workers.renew({ nodeId, session, disk: disk(4e9) })),
    );
    await workers.renew({ nodeId, session, disk: disk(10.5e9) });
    expect(lowEvents()).toHaveLength(1);
    expect(lowEvents()[0]).toMatchObject({
      project: PROVISIONER,
      event: {
        source: "machines",
        kind: "machine.disk-low",
        payload: {
          name,
          class: "fleet",
          rule: "fleet-k",
          ref: "i-0ddd",
          disk: { freeBytes: 4e9, totalBytes: 100e9, floorBytes: 10e9 },
          options: OPTIONS,
        },
      },
    });
    // Room again, then short again: a second episode, a second event.
    await workers.renew({ nodeId, session, disk: disk(30e9) });
    await workers.renew({ nodeId, session, disk: disk(3e9) });
    const [first, second] = lowEvents();
    expect(lowEvents()).toHaveLength(2);
    expect(second?.event.externalId).not.toBe(first?.event.externalId);
    // A new machine under the same name inherits nothing of the old one's
    // disk: under its floor at once, it is an episode of its own.
    await workers.revoke({ name });
    const again = await workers.createMachineEnrollment({
      name,
      rule: "fleet-k",
      ttlMinutes: 15,
      placement: { labels: { class: "fleet" }, access: { groups: [ENG] } },
    });
    if (!again) throw new Error("No enrollment for the new machine");
    const { publicKey } = generateExecutorKeyPair();
    const { nodeId: reused } = await workers.enroll({
      code: again.code,
      publicKey,
    });
    expect(reused).toBe(nodeId);
    expect(
      (await registry().machines()).find((machine) => machine.name === name),
    ).toBeDefined();
    const nodes = await new WorkerNodesService(db()).list({
      tenantId: SERVER_TENANT_ID,
      authorityId,
    });
    expect(nodes.find((node) => node.id === nodeId)).not.toHaveProperty(
      "diskLowSince",
    );
    await workers.connect({
      nodeId,
      name,
      session: epoch(),
      offer: WorkerOfferSchema.parse({
        isolation: "sandbox",
        workspaceRoot: "/workspaces",
        capacity: { workspaces: 1 },
        disk: disk(2e9),
      }),
      publicKey,
    });
    expect(lowEvents()).toHaveLength(3);
    await reconciler.deleteRule("fleet-k");
  });

  it("tells it once when a rule's machines come up short of disk, and makes no more for a while (ADR 0335)", async () => {
    const { workflows, reconciler, workers, pass } = setup();
    await reconciler.setRule({
      name: "fleet-s",
      rule: {
        group: ENG,
        machines: { demand: { max: 2, min: 1 } },
        class: "fleet",
        trusted: true,
      },
    });
    await pass();
    const [create] = workflows.creates();
    if (!create) throw new Error("No create was started");
    const { name } = create.input;
    workflows.answer(create.correlationKey, { ref: "i-0sss" });
    await pass();
    const { publicKey } = generateExecutorKeyPair();
    const { nodeId } = await workers.enroll({
      code: create.input.enrollment.code,
      publicKey,
    });
    await workers.connect({
      nodeId,
      name,
      session: epoch(),
      offer: WorkerOfferSchema.parse({
        isolation: "sandbox",
        workspaceRoot: "/workspaces",
        capacity: { workspaces: 1 },
        disk: {
          path: "/var/lib/work-worker",
          totalBytes: 20e9,
          freeBytes: 1e9,
          floorBytes: 2e9,
          criticalBytes: 0.2e9,
          measuredAt: new Date().toISOString(),
        },
      }),
      publicKey,
    });
    await pass();
    await pass();
    const small = workflows.events.filter(
      (event) => event.event.kind === "machine.disk-too-small",
    );
    expect(small).toHaveLength(1);
    expect(small[0]).toMatchObject({
      project: PROVISIONER,
      event: { payload: { rule: "fleet-s", class: "fleet", options: OPTIONS } },
    });
    // The short machine goes; none replaces it while the rule is braked.
    expect(workflows.creates()).toHaveLength(1);
    await reconciler.deleteRule("fleet-s");
  });
});
