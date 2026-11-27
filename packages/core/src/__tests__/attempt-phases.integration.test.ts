import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type { EnvironmentRuntimeBinding } from "@catamorphic/sandbox";
import {
  cleanupTestResources,
  TestSandboxes,
} from "@catamorphic/sandbox/testing";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { PlacementWaitsService } from "../services/placement-waits.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { SessionOperationsService } from "../services/session-operations.js";
import { SessionWorkspaces } from "../services/session-workspaces.js";
import {
  ATTEMPT_PHASES,
  type AttemptPhase,
} from "../services/sessions/attempt-phases.js";
import type { AttemptRecord } from "../services/sessions/turn-stalls.js";
import { WorkspaceCheckoutsService } from "../services/workspace-checkouts.js";
import { RecordingAdapter } from "./recording-adapter.js";
import { startCheckoutGateway } from "./test-checkout-gateway.js";

const ownedSandboxes = new TestSandboxes();

/**
 * How long each part of an attempt's preparation took (ADR 0354), end to
 * end with real sandboxes, a gateway they fetch their base from and a real
 * setup command: what a first turn records, what a later turn in the same
 * sandbox records, what a turn that waited for a machine records, and what
 * a workflow reads.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_attempt_phases";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "ada",
};
const PROJECT_DIR = "/workspace/project";

/**
 * The Environment's setup: it writes why it ran and on which commits, once
 * the test lets it go (while `hold` is there, it waits).
 */
const setupCommand = (hold: string) =>
  [
    `while [ -e '${hold}' ]; do sleep 0.05; done`,
    `echo "$WORK_SETUP_REASON $WORK_BASE \${WORK_PREVIOUS_BASE:-unset}" >> ../setups`,
  ].join("\n");

describe("an attempt records how long each part of its preparation took (ADR 0354)", () => {
  let tmpDir: string;
  /** While this file is there, every setup waits. */
  let hold: string;
  let projectId: string;
  let projectManager: ProjectManager;
  let sessions: AgentSessionsService;
  let uploading: AgentSessionsService;
  let actions: SessionOperationsService;
  let machine: LocalProcessSandboxProvider;
  let gateway: Awaited<ReturnType<typeof startCheckoutGateway>>;
  const allocations = new ExecutionAllocationsService(db);
  const adapter = new RecordingAdapter();

  const sandboxOf = async (sessionId: string) =>
    (
      await db
        .selectFrom("agent_sessions")
        .innerJoin(
          "project_sandboxes",
          "project_sandboxes.id",
          "agent_sessions.sandbox_id",
        )
        .select("project_sandboxes.provider_id")
        .where("agent_sessions.id", "=", sessionId)
        .executeTakeFirstOrThrow()
    ).provider_id;

  const main = () =>
    projectManager.mainCommit({ tenantId: identity.tenantId, projectId });

  /** What the chat's setups wrote, one line a run. */
  const setups = async (sessionId: string) =>
    (
      await machine.executeCommand(
        await sandboxOf(sessionId),
        "cat ../setups 2>/dev/null",
        { cwd: PROJECT_DIR },
      )
    ).result
      .split("\n")
      .filter(Boolean);

  /** One turn to its end; its only attempt, as a reader gets it. */
  const turn = async (input: {
    sessionId: string;
    service?: AgentSessionsService;
  }): Promise<AttemptRecord> => {
    const service = input.service ?? sessions;
    const result = await service.sendMessage(
      identity,
      projectId,
      input.sessionId,
      "work",
    );
    expect(result.turn.status).toBe("completed");
    const attempts = await service.attempts(
      identity,
      projectId,
      input.sessionId,
      { turnId: result.turn.id },
    );
    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;
    if (!attempt) throw new Error("The turn has no attempt");
    return attempt;
  };

  /**
   * Every phase ended, none before it started, each after the one before
   * it, and all of them within the attempt (the wait for a machine is
   * before it).
   */
  const expectTimeline = (attempt: AttemptRecord) => {
    const at = (value: string | null) => {
      if (value === null) throw new Error("A phase or attempt has no time");
      return Date.parse(value);
    };
    let previous = Number.NEGATIVE_INFINITY;
    for (const phase of attempt.phases) {
      expect(ATTEMPT_PHASES).toContain(phase.phase);
      expect(at(phase.startedAt)).toBeGreaterThanOrEqual(previous);
      expect(at(phase.endedAt)).toBeGreaterThanOrEqual(at(phase.startedAt));
      previous = at(phase.endedAt);
      if (phase.phase === "machine.wait") continue;
      expect(at(phase.startedAt)).toBeGreaterThanOrEqual(at(attempt.startedAt));
      expect(at(phase.endedAt)).toBeLessThanOrEqual(at(attempt.completedAt));
    }
  };

  const names = (attempt: { phases: AttemptPhase[] }) =>
    attempt.phases.map((phase) => phase.phase);

  /** Give the chat's workspace back, as an idle one is. */
  const release = async (sessionId: string) => {
    const row = await db
      .selectFrom("agent_sessions")
      .select("allocation_id")
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    await allocations.release({
      identity,
      allocationId: row.allocation_id ?? "",
      reason: "idle",
    });
  };

  /** The chat waits for a machine since `seconds` ago, last tried `tried` ago. */
  const waiting = async (input: {
    sessionId: string;
    seconds: number;
    triedSecondsAgo: number;
  }) => {
    await new PlacementWaitsService(db).record({
      tenantId: identity.tenantId,
      projectId,
      workloadKind: "agent",
      rootWorkloadId: input.sessionId,
      target: {
        environmentName: "work",
        reason: "capacity",
        pool: {},
        owner: identity.externalUserId,
        key: null,
        requirements: { resources: {}, capabilities: [] },
        waitMinutes: 30,
      },
      limitMinutes: 30,
    });
    await db
      .updateTable("placement_waits")
      .set({
        waiting_since: sql<Date>`now() - make_interval(secs => ${input.seconds})`,
        last_tried_at: sql<Date>`now() - make_interval(secs => ${input.triedSecondsAgo})`,
        // Its backoff ended: admission is tried again at once.
        retry_at: sql<Date>`now()`,
      })
      .where("root_workload_id", "=", input.sessionId)
      .execute();
  };

  /** The chat's turns, oldest first. */
  const turnsOf = (sessionId: string) =>
    db
      .selectFrom("agent_turns")
      .select(["id", "status"])
      .where("session_id", "=", sessionId)
      .orderBy("ordinal")
      .execute();

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "attempt-phases-"));
    hold = path.join(tmpDir, "hold");
    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
      new FsRemoteBackend(path.join(tmpDir, "origins")),
    );
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    projectId = (await projects.create(identity, { name: "Reviews" })).id;
    await projectManager.publishFiles({
      tenantId: identity.tenantId,
      projectId,
      files: {
        "README.md": "reviews\n",
        [PROJECT_MANIFEST_PATH]: JSON.stringify({
          environments: {
            work: {
              workloads: ["agent"],
              setup: { command: setupCommand(hold) },
            },
          },
          defaultEnvironment: "work",
        }),
      },
      message: "Published",
      author: { name: "Test", email: "test@example.com" },
    });

    machine = ownedSandboxes.track(
      new LocalProcessSandboxProvider({ root: path.join(tmpDir, "machine") }),
    );
    const binding: EnvironmentRuntimeBinding = {
      descriptor: {
        id: "machine",
        label: "Machine",
        trust: "managed",
        isolation: "sandbox",
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: [],
        resources: {},
      },
      sandboxProvider: machine,
    };
    const agent: RegisteredCodingAgent = {
      id: "coder",
      harness: { placement: "host", adapter },
      topology: "controller",
    };
    const checkouts = new WorkspaceCheckoutsService(db, { projectManager });
    gateway = await startCheckoutGateway(() => checkouts);
    const service = (gatewayUrl: string | undefined) =>
      new AgentSessionsService(db, {
        hostId: "attempt-phases-host",
        projectManager,
        executionEnvironments: new ExecutionEnvironmentsService(
          new ProjectEnvironmentsService(db, projectManager),
          {
            get: ({ allocationBindingId }) =>
              !allocationBindingId || allocationBindingId === "machine"
                ? binding
                : undefined,
          },
        ),
        executionAllocations: allocations,
        codingAgents: {
          defaultAgentId: () => agent.id,
          get: (id) => (id === agent.id ? agent : undefined),
          list: () => [agent],
        },
        workspaces: new SessionWorkspaces({
          projectManager,
          origin: async () => null,
        }),
        ...(gatewayUrl
          ? {
              checkouts,
              sandboxGateway: {
                url: () => gatewayUrl,
                remoteBaseUrls: () => undefined,
                modelApi: () => undefined,
                servesHttp: () => true,
              },
            }
          : {}),
      });
    sessions = service(gateway.url);
    // A host that serves no gateway: its sandboxes get their base uploaded.
    uploading = service(undefined);
    actions = new SessionOperationsService(db, sessions, {
      watchers: () => undefined,
      chatOwner: async (input: { caller: Identity }) => input.caller,
    });
  }, 60_000);

  afterAll(async () => {
    await cleanupTestResources(
      [
        () => sessions?.stopLocalTurns(),
        () => uploading?.stopLocalTurns(),
        () => ownedSandboxes.cleanup(),
        () => gateway?.close(),
        () => db.destroy(),
      ],
      () => fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 }),
    );
  });

  it("times a first turn's sandbox, checkout, restore, setup and harness, and only the harness of a later turn in the same sandbox", async () => {
    const chat = await sessions.create(identity, projectId, {});
    const first = await turn({ sessionId: chat.id });
    expect(names(first)).toEqual([
      "sandbox.create",
      "workspace.checkout",
      "workspace.restore",
      "setup.environment",
      "harness.start",
      "harness.first-output",
    ]);
    expectTimeline(first);
    // The setup really ran, told what it ran on and why.
    expect(await setups(chat.id)).toEqual([`created ${await main()} unset`]);

    // The same sandbox: nothing to make, check out, restore or set up.
    const later = await turn({ sessionId: chat.id });
    expect(names(later)).toEqual(["harness.start", "harness.first-output"]);
    expectTimeline(later);
    expect(await setups(chat.id)).toHaveLength(1);
    // The first attempt's phases stay as they were once its turn settled.
    const [turns] = [await turnsOf(chat.id)];
    expect(
      await sessions.attempts(identity, projectId, chat.id, {
        turnId: turns[0]?.id ?? "",
      }),
    ).toEqual([first]);
  }, 60_000);

  it("returns the phases to a workflow that reads a turn's attempts", async () => {
    const chat = await sessions.create(identity, projectId, {});
    const attempt = await turn({ sessionId: chat.id });
    const [first] = await turnsOf(chat.id);
    const read = await actions.execute({
      identity,
      projectId,
      operation: "session_read",
      args: { sessionId: chat.id, turnId: first?.id, include: ["attempts"] },
      author: { kind: "user", externalUserId: identity.externalUserId },
    });
    expect(read).toMatchObject({
      sessionId: chat.id,
      attempts: [{ id: attempt.id, status: "completed" }],
    });
    const attempts: unknown = Reflect.get(Object(read), "attempts");
    expect(Array.isArray(attempts) && attempts[0]?.phases).toEqual(
      attempt.phases,
    );
    expect(attempt.phases.length).toBeGreaterThan(0);
  }, 60_000);

  it("shows the phase a preparation is in while it runs", async () => {
    const chat = await sessions.create(identity, projectId, {});
    await turn({ sessionId: chat.id });
    // Its next workspace's setup waits until the test lets it go.
    await release(chat.id);
    await fs.writeFile(hold, "");
    const sending = sessions.sendMessage(identity, projectId, chat.id, "work");
    // Attached now: a failure still surfaces when it is awaited below.
    void sending.catch(() => {});
    const running = await vi.waitFor(
      async () => {
        const [, second] = await turnsOf(chat.id);
        if (!second) throw new Error("The turn has not started");
        const [attempt] = await sessions.attempts(
          identity,
          projectId,
          chat.id,
          { turnId: second.id },
        );
        expect(attempt?.phases.at(-1)).toMatchObject({
          phase: "setup.environment",
          endedAt: null,
        });
        return attempt;
      },
      { timeout: 30_000, interval: 50 },
    );
    // What came before it ended; the attempt has not.
    expect(running?.completedAt).toBeNull();
    expect(
      running?.phases.slice(0, -1).every((phase) => phase.endedAt !== null),
    ).toBe(true);
    await fs.rm(hold);
    expect((await sending).turn.status).toBe("completed");
    const [, second] = await turnsOf(chat.id);
    const [settled] = await sessions.attempts(identity, projectId, chat.id, {
      turnId: second?.id ?? "",
    });
    if (!settled) throw new Error("The turn has no attempt");
    expect(names(settled)).toEqual([
      "sandbox.create",
      "workspace.checkout",
      "workspace.restore",
      "setup.environment",
      "harness.start",
      "harness.first-output",
    ]);
    expectTimeline(settled);
    // A workspace made again says so to its setup.
    expect(await setups(chat.id)).toEqual([`rebuilt ${await main()} unset`]);
  }, 90_000);

  it("gives the wait for a machine to the first attempt placed after it, once", async () => {
    const chat = await sessions.create(identity, projectId, {});
    // Placed at once: it waited for no machine.
    expect(names(await turn({ sessionId: chat.id }))).not.toContain(
      "machine.wait",
    );
    await release(chat.id);
    await waiting({ sessionId: chat.id, seconds: 40, triedSecondsAgo: 1 });
    // A send answers at once that the chat waits; the turn runs when placed.
    await sessions
      .sendMessage(identity, projectId, chat.id, "work")
      .catch(() => {});
    const waited = await vi.waitFor(
      async () => {
        const [, second] = await turnsOf(chat.id);
        expect(second?.status).toBe("completed");
        const [attempt] = await sessions.attempts(
          identity,
          projectId,
          chat.id,
          { turnId: second?.id ?? "" },
        );
        if (!attempt) throw new Error("The turn has no attempt");
        return attempt;
      },
      { timeout: 30_000, interval: 100 },
    );
    expect(names(waited)).toEqual([
      "machine.wait",
      "sandbox.create",
      "workspace.checkout",
      "workspace.restore",
      "setup.environment",
      "harness.start",
      "harness.first-output",
    ]);
    expectTimeline(waited);
    const [wait] = waited.phases;
    const seconds =
      (Date.parse(wait?.endedAt ?? "") - Date.parse(wait?.startedAt ?? "")) /
      1_000;
    expect(seconds).toBeGreaterThanOrEqual(39);
    expect(seconds).toBeLessThan(70);
    // It ended before the attempt began: the chat was placed, then claimed.
    expect(Date.parse(wait?.endedAt ?? "")).toBeLessThanOrEqual(
      Date.parse(waited.startedAt ?? ""),
    );
    // Taken once: the next attempt on the same machine waited for none.
    expect(names(await turn({ sessionId: chat.id }))).toEqual([
      "harness.start",
      "harness.first-output",
    ]);

    // A wait nobody tried for a while was no wait any more (ADR 0258).
    await release(chat.id);
    await waiting({ sessionId: chat.id, seconds: 900, triedSecondsAgo: 300 });
    expect(names(await turn({ sessionId: chat.id }))).not.toContain(
      "machine.wait",
    );
  }, 120_000);

  it("times the restore alone where the base is uploaded with the chat's work", async () => {
    const chat = await uploading.create(identity, projectId, {});
    const attempt = await turn({ sessionId: chat.id, service: uploading });
    // No gateway serves the base: it arrives with the restore.
    expect(names(attempt)).toEqual([
      "sandbox.create",
      "workspace.restore",
      "setup.environment",
      "harness.start",
      "harness.first-output",
    ]);
    expectTimeline(attempt);
  }, 60_000);
});
