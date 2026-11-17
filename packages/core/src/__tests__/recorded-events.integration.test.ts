import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, type Json, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import type {
  DeploymentRuntimeProvider,
  RuntimeInvocation,
  RuntimeInvocationReceipt,
  RuntimeTerminalResult,
  SandboxProvider,
} from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { EVENTS_CAPABILITY } from "../services/events-capability.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";
import { webhookConfig } from "../webhook-ingress.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * `host["catamorphic.events"].record` (ADR 0326): a workflow that declared
 * `events:write` records events of the project's own kinds, and they start
 * the workflows bound to those kinds exactly as webhook deliveries do. The
 * runtime is faked at the invocation boundary, returning the transitions a
 * real boundary would.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_rec_${crypto.randomUUID().replaceAll("-", "")}`;

const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

/** The host webhook kind, with the payload shape a stored delivery has. */
const webhookKind: TriggerKindRuntime = {
  name: "webhook",
  modes: ["async"],
  payloadJsonSchema: { type: "object" },
  configJsonSchema: z.toJSONSchema(webhookConfig, { io: "input" }) as Json,
  validatePayload: (value) => {
    const parsed = z
      .object({
        source: z.literal("webhook"),
        payload: z.object({
          name: z.string(),
          headers: z.record(z.string(), z.string()),
          query: z.record(z.string(), z.string()),
          contentType: z.string().nullable(),
          body: z.json(),
        }),
      })
      .safeParse(value);
    return parsed.success
      ? { ok: true }
      : {
          ok: false,
          errors: parsed.error.issues.map(
            (issue) => `${issue.path.join(".")}: ${issue.message}`,
          ),
        };
  },
  validateConfig: (value) =>
    webhookConfig.safeParse(value).success
      ? { ok: true }
      : { ok: false, errors: ["invalid webhook config"] },
  matches: ({ config, payload }) =>
    webhookConfig.safeParse(config).data?.name ===
    z.object({ payload: z.object({ name: z.string() }) }).safeParse(payload)
      .data?.payload.name,
  correlationKey: (payload) =>
    z.object({ id: z.string() }).safeParse(payload).data?.id,
};

const ticketCreated: TriggerKindRuntime = {
  name: "ticket.created",
  payloadJsonSchema: { type: "object" },
  configJsonSchema: { type: "object" },
  validatePayload: () => ({ ok: true }),
  validateConfig: () => ({ ok: true }),
};

const TRIGGERS = `
import { defineTrigger, trigger } from "@catamorphic/workflow";

export const delivery = defineTrigger({
  name: "github.delivery",
  from: trigger("webhook", { name: "github" }),
});

export const pullRequest = defineTrigger({
  name: "github.pull_request",
  from: trigger("github.delivery"),
  where: { payload: { headers: { "x-github-event": "pull_request" } } },
});

export const urgentTicket = defineTrigger({
  name: "ticket.urgent",
  from: trigger("ticket.created"),
});
`;

const WORKFLOWS = `
export const pollGithub = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["events:write"],
  steps: [
    defineBoundary({ run: ({ input, host }: BoundaryContext<{ events: unknown[] }>) => host["catamorphic.events"].record(input) }),
    defineBoundary({ run: ({ input }: BoundaryContext<{ events: unknown[] }>) => input }),
  ],
}));

export const sneakyRecord = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({ run: ({ input, host }: BoundaryContext<{ events: unknown[] }>) => host["catamorphic.events"].record(input) }),
  ],
}));

export const onPullRequest = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("github.pull_request")],
  steps: [defineBoundary({ run: async ({ input }: BoundaryContext<{ id: string }>) => ({ id: input.id }) })],
}));

export const echoPullRequests = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["events:write"],
  triggers: [trigger("github.pull_request")],
  steps: [
    defineBoundary({ run: ({ input, host }: BoundaryContext<{ id: string }>) => host["catamorphic.events"].record({ events: [] }) }),
    defineBoundary({ run: ({ input }: BoundaryContext<{ events: unknown[] }>) => input }),
  ],
}));
`;

/** A pull request delivery's payload as the GitHub library matches it. */
function pullRequest(action: string, extra: Record<string, Json> = {}) {
  return {
    name: "github",
    headers: { "x-github-event": "pull_request" },
    query: {},
    contentType: "application/json",
    body: { action, number: 7 },
    ...extra,
  };
}

function invokeRuntime(
  invocation: RuntimeInvocation,
): Promise<RuntimeInvocationReceipt> {
  if (invocation.kind !== "durable-boundary")
    throw new Error(`Unexpected invocation kind '${invocation.kind}'`);
  const { exportName, stepIndex } = invocation.target;
  const value = ((invocation.input as { value?: unknown }).value ??
    {}) as Record<string, unknown>;
  const record = (args: unknown): RuntimeTerminalResult => ({
    status: "completed",
    result: {
      type: "host_call",
      transition: {
        __catamorphicDurableTransition: "host_call",
        capability: EVENTS_CAPABILITY,
        fn: "record",
        args,
      },
    },
    steps: [],
  });
  const done: RuntimeTerminalResult = {
    status: "completed",
    result: { type: "completed", output: value as Json },
    steps: [],
  };
  // The echo records a pull request event for every one it receives,
  // which would start itself again without causation.
  const terminal =
    stepIndex !== 0
      ? done
      : exportName === "pollGithub" || exportName === "sneakyRecord"
        ? record(value)
        : exportName === "echoPullRequests"
          ? record({
              events: [
                {
                  kind: "github.pull_request",
                  id: `echo:${String(value.id)}`,
                  payload: pullRequest("echoed"),
                },
              ],
            })
          : done;
  return Promise.resolve({
    runtimeId: invocation.runtimeId,
    invocationId: invocation.invocationId,
    events: [],
    terminal,
  });
}

class FakeSandboxProvider implements SandboxProvider {
  readonly workspaceRoot = "/workspace";
  readonly deploymentRuntime: DeploymentRuntimeProvider = {
    ensureRuntime: async (args) => ({
      runtimeId: "fake-runtime",
      sandboxId: args.sandboxId,
      deploymentArtifactId: args.deploymentArtifactId,
      artifactDigest: args.artifactDigest,
      transformVersion: args.transformVersion,
      runtimeVersion: args.runtimeVersion,
      generation: "1",
      status: "healthy",
    }),
    invoke: (args) => invokeRuntime(args),
    cancel: async () => {},
    getHealth: async ({ runtimeId }) => ({
      runtimeId,
      runtimeStatus: "healthy",
      protocolVersion: 8,
      status: "healthy",
      activeInvocations: 0,
      queuedInvocations: 0,
      maxConcurrency: 8,
    }),
  };
  async createSandbox() {
    return {
      id: crypto.randomUUID(),
      providerId: `fake-sandbox-${crypto.randomUUID()}`,
      sandboxType: "execution" as const,
      status: "started" as const,
    };
  }
  async startSandbox(): Promise<void> {}
  async stopSandbox(): Promise<void> {}
  async destroySandbox(): Promise<void> {}
  async getSandboxStatus() {
    return "started" as const;
  }
  async executeCommand() {
    return { exitCode: 0, result: "" };
  }
  async uploadFiles(): Promise<void> {}
  async downloadFile(): Promise<string> {
    return "";
  }
  async gitClone(): Promise<void> {}
  async gitCheckout(): Promise<void> {}
}

describeIf("catamorphic.events host calls (ADR 0326)", () => {
  let tmpDir: string;
  let core: CatamorphicCore;
  let db: ReturnType<typeof createDatabase>;
  let projectId: string;
  let echoEnablementId: string;
  /** Bob may run the recorders and holds events:write. */
  let bob: Identity;

  const record = (events: unknown[], identity: Identity = root) =>
    core.runs.call({
      identity,
      projectId,
      workflowName: "pollGithub",
      input: { events } as Json,
      budgetMs: 20_000,
    });
  const runsOf = async (workflowName: string) =>
    db
      .selectFrom("workflow_runs")
      .select(["id", "status", "input"])
      .where("project_id", "=", projectId)
      .where("workflow_name", "=", workflowName)
      .orderBy("created_at")
      .execute();
  const recordedEvents = () =>
    db
      .selectFrom("project_events")
      .select(["id", "external_id", "kind", "source", "payload"])
      .where("project_id", "=", projectId)
      .where("external_id", "like", "recorded:%")
      .orderBy("sequence")
      .execute();

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-rec-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "dev")),
      new FsRemoteBackend(path.join(tmpDir, "origin")),
    );
    db = createDatabase({ connectionString, schema, poolSize: 8 });
    await migrateToLatest({ db, schema });
    const sandboxProvider = new FakeSandboxProvider();
    core = new CatamorphicCore({
      db,
      projectManager,
      sandboxProvider,
      environmentProvider: testEnvironmentProvider(sandboxProvider),
      triggerKinds: [webhookKind, ticketCreated],
      // Small enough that a test payload exceeds it.
      webhooks: { maxBodyBytes: 2_048 },
      resolveMemberIdentity: async ({ tenantId, projectId, externalUserId }) =>
        projectId && externalUserId === "bob"
          ? {
              tenantId,
              externalUserId,
              scope: [{ kind: "workflow", projectId, name: "*" }],
              projectPermissions: [{ projectId, permission: "events:write" }],
            }
          : null,
    });
    const project = await core.projects.create(root, { name: "recorded" });
    projectId = project.id;
    await core.projects.writeFile(root, projectId, ".work/triggers/github.ts", {
      content: TRIGGERS,
      commitMessage: "Add trigger kinds",
    });
    await core.projects.writeFile(
      root,
      projectId,
      ".work/workflows/src/recorders.ts",
      { content: WORKFLOWS, commitMessage: "Add recorders" },
    );
    const deployed = await core.deployment.deploy(
      root.tenantId,
      projectId,
      root.externalUserId,
      { message: "deploy" },
    );
    expect(deployed.status).toBe("deployed");
    for (const workflowName of ["onPullRequest", "echoPullRequests"]) {
      const preview = await core.workflowEnablements.preview({
        identity: root,
        projectId,
        workflowName,
      });
      const enablement = await core.workflowEnablements.create({
        identity: root,
        projectId,
        workflowName,
        consentDigest: preview.consentDigest,
      });
      if (workflowName === "echoPullRequests") echoEnablementId = enablement.id;
    }
    bob = {
      ...root,
      externalUserId: "bob",
      executionScope: [{ projectId, name: "default" }],
      scope: [
        { kind: "workflow", projectId, name: "pollGithub" },
        { kind: "workflow", projectId, name: "sneakyRecord" },
      ],
      projectPermissions: [{ projectId, permission: "events:write" }],
    };
  }, 120_000);

  afterAll(async () => {
    await core.runs.stopWorkers();
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("records an event that starts the workflows bound to its kind, never the recorder's own", async () => {
    const outcome = await record([
      {
        kind: "github.pull_request",
        id: "pull_request:7:opened:abc",
        payload: pullRequest("opened", {
          // A recorder cannot claim another origin or causation.
          origin: { type: "request" },
          causation: [],
        }),
        occurredAt: "2026-11-17T10:00:00Z",
      },
    ]);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    const [run] = await runsOf("pollGithub");
    expect(outcome.output).toEqual({
      events: [
        {
          kind: "github.pull_request",
          id: "pull_request:7:opened:abc",
          eventId: expect.any(String),
          created: true,
          occurredAt: "2026-11-17T10:00:00.000Z",
          receivedAt: expect.any(String),
        },
      ],
    });
    const [stored] = await recordedEvents();
    expect(stored).toMatchObject({
      external_id: "recorded:github.pull_request:pull_request:7:opened:abc",
      kind: "webhook",
      source: "webhook",
      payload: {
        ...pullRequest("opened"),
        origin: {
          type: "workflow",
          workflowName: "pollGithub",
          runId: run?.id,
        },
        causation: [],
      },
    });

    // It reaches both bound workflows like a delivery.
    await core.dispatchEvents();
    const [echo] = await runsOf("echoPullRequests");
    expect(
      await core.runs.driveInline({
        tenantId: root.tenantId,
        runId: echo?.id ?? "",
        deadline: Date.now() + 20_000,
      }),
    ).toMatchObject({ status: "completed" });
    expect(await runsOf("onPullRequest")).toHaveLength(1);

    // The echo's own event reaches the other workflow, not the echo.
    const echoed = (await recordedEvents()).find((event) =>
      event.external_id.includes("echo:"),
    );
    expect(echoed?.payload).toMatchObject({
      origin: {
        type: "workflow",
        workflowName: "echoPullRequests",
        enablementId: echoEnablementId,
      },
      causation: [echoEnablementId],
    });
    await core.dispatchEvents();
    expect(await runsOf("onPullRequest")).toHaveLength(2);
    expect(await runsOf("echoPullRequests")).toHaveLength(1);
    const suppressed = await db
      .selectFrom("project_event_deliveries")
      .select(["status", "error", "run_ids"])
      .where("event_id", "=", echoed?.id ?? "")
      .execute();
    expect(suppressed).toContainEqual({
      status: "completed",
      error: "Causal cycle suppressed",
      run_ids: [],
    });
  }, 60_000);

  it("records an id the project already has as a no-op returning the existing event", async () => {
    const event = {
      kind: "github.pull_request",
      id: "pull_request:8:opened:def",
      payload: pullRequest("opened"),
    };
    const first = await record([event]);
    const second = await record([event, event]);
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") return;
    const created = (first.output as { events: { eventId: string }[] })
      .events[0];
    expect(second.output).toEqual({
      events: [
        expect.objectContaining({
          eventId: created?.eventId,
          created: false,
        }),
        expect.objectContaining({
          eventId: created?.eventId,
          created: false,
        }),
      ],
    });
    expect(
      (await recordedEvents()).filter((stored) =>
        stored.external_id.endsWith(":pull_request:8:opened:def"),
      ),
    ).toHaveLength(1);
  });

  it.each([
    [
      "a host kind",
      { kind: "webhook", payload: pullRequest("opened") },
      "'webhook' is a host kind",
    ],
    [
      "a session kind",
      { kind: "session.turn-changed", payload: {} },
      "is not a trigger kind of this project",
    ],
    [
      "an unknown kind",
      { kind: "github.release", payload: pullRequest("opened") },
      "is not a trigger kind of this project",
    ],
    [
      "a project kind over another host kind",
      { kind: "ticket.urgent", payload: { ticketId: "T-1" } },
      "builds on 'ticket.created'",
    ],
    [
      "a payload its kind would not deliver",
      {
        kind: "github.pull_request",
        payload: {
          ...pullRequest("created"),
          headers: { "x-github-event": "issue_comment" },
        },
      },
      "does not match the filters of 'github.pull_request'",
    ],
    [
      "a payload for another webhook",
      {
        kind: "github.pull_request",
        payload: { ...pullRequest("opened"), name: "stripe" },
      },
      "does not match the 'webhook' config",
    ],
    [
      "a payload without the kind's shape",
      { kind: "github.pull_request", payload: { name: "github" } },
      "is not a 'github.pull_request' event",
    ],
    [
      "a payload over the size limit",
      {
        kind: "github.pull_request",
        payload: {
          ...pullRequest("opened"),
          body: { action: "opened", text: "x".repeat(4_096) },
        },
      },
      "the limit is 2048",
    ],
  ])("refuses %s and records nothing", async (_name, event, message) => {
    const before = (await recordedEvents()).length;
    const outcome = await record([
      { kind: "github.pull_request", id: "ok", payload: pullRequest("opened") },
      { id: `refused:${crypto.randomUUID()}`, ...event },
    ]);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error).toContain(message);
    expect(await recordedEvents()).toHaveLength(before);
  });

  it("records only for a workflow that declared events:write", async () => {
    const event = {
      kind: "github.pull_request",
      id: "pull_request:9:opened:aaa",
      payload: pullRequest("opened"),
    };
    const refused = await core.runs.call({
      identity: bob,
      projectId,
      workflowName: "sneakyRecord",
      input: { events: [event] },
      budgetMs: 20_000,
    });
    expect(refused.status).toBe("failed");
    if (refused.status === "failed")
      expect(refused.error).toContain("Recording events needs events:write");
    const allowed = await record([event], bob);
    expect(allowed).toMatchObject({ status: "completed" });
  });
});
