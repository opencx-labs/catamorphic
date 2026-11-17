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
  /** A start that fails without saying whether a run began. */
  lost: string | undefined;

  async start(args: Started) {
    if (this.refuse) throw new MachineProvisioningRefusedError(this.refuse);
    if (this.lost) throw new Error(this.lost);
    this.started.push(args);
    this.runs.set(args.correlationKey, { status: "active" });
  }

  async latest(args: { correlationKey: string }) {
    return this.runs.get(args.correlationKey);
  }

  async record(args: Parameters<MachineWorkflows["record"]>[0]) {
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

function setup() {
  const workflows = new FakeWorkflows();
  const reconciler: MachineReconciler = new MachineReconciler({
    db: db(),
    tenantId: SERVER_TENANT_ID,
    workers: registry(),
    classes,
    workflows,
    install: installTarget({
      publicBase: PUBLIC,
      workerImage: "ghcr.io/acme/work-server:test",
    }),
    controlPlaneUrl: PUBLIC,
    emailOf: async () => undefined,
  });
  // Machines' first calls reach this reconciler, as the server wires it.
  const workers = registry((machine) => reconciler.machineConnected(machine));
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
) {
  return new WorkWorkerRegistry({
    db: db(),
    nodes: new WorkerNodesService(db()),
    tenantId: SERVER_TENANT_ID,
    authorityId,
    ...(firstContact ? { firstContact } : {}),
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
}) {
  const { publicKey } = generateExecutorKeyPair();
  const { nodeId } = await args.workers.enroll({ code: args.code, publicKey });
  if (args.connect)
    await args.workers.connect({
      nodeId,
      name: args.name,
      session: epoch(),
      offer: WorkerOfferSchema.parse({
        isolation: "sandbox",
        workspaceRoot: "/workspaces",
        capacity: { workspaces: 1 },
      }),
      publicKey,
    });
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

  it("keeps the code when a start failed without saying whether a run began", async () => {
    const { workflows, reconciler, pass } = setup();
    workflows.lost = "connection reset";
    await reconciler.setRule(shared("fleet-h"));
    const name = sharedName("fleet-h", "fleet", ENG, 1);
    expect((await pass()).failed).toEqual([
      expect.objectContaining({ name, error: "connection reset" }),
    ]);
    const pending = await machine(name);
    const key = pending?.ref?.replace("creating:", "");
    expect(pending?.state).toBe("pending");
    // No run is found: the machine may still be coming up, so its code
    // stays and nothing is started again.
    workflows.lost = undefined;
    expect((await pass()).failed).toEqual([
      expect.objectContaining({
        name,
        error: expect.stringContaining("no run for this machine"),
      }),
    ]);
    expect(await machine(name)).toMatchObject({
      state: "pending",
      ref: `unknown:${key}`,
    });
    await pass();
    expect(workflows.creates(name)).toEqual([]);
  });

  it("treats a failed create as uncertain and asks destroy until it is done", async () => {
    const { workflows, reconciler, pass } = setup();
    await reconciler.setRule(shared("fleet-d"));
    const name = sharedName("fleet-d", "fleet", ENG, 1);
    await pass();
    const [create] = workflows.creates(name);
    if (!create) throw new Error("No create was started");
    const key = create.input.enrollment.idempotencyKey;
    workflows.runs.set(create.correlationKey, {
      status: "failed",
      error: "RequestTimeout",
    });
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
      // No ref is known: destroy finds the machine by its name.
      input: {
        name,
        class: "fleet",
        rule: "fleet-d",
        ref: null,
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
});
