import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type {
  RuntimeInvocationReceipt,
  SandboxProvider,
} from "@catamorphic/sandbox";
import {
  cleanupTestResources,
  TestSandboxes,
} from "@catamorphic/sandbox/testing";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CatamorphicCore } from "../core.js";
import { startEventDispatcher } from "../event-dispatcher.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { projectChatIdentity } from "../services/chat-delivery.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";
import {
  recordWorkspaceGone,
  WORKSPACE_SETUP_EVENT,
} from "../services/workspace-events.js";
import { RecordingAdapter } from "./recording-adapter.js";
import { testEnvironmentProvider } from "./test-environment.js";

const ownedSandboxes = new TestSandboxes();

/*
 * Workflows run commands in a chat's workspace (ADR 0324), on real
 * local-process sandboxes: `exec` in the chat's own sandbox, seeing its
 * checkout and a read-only copy of the program; a command longer than its
 * attempt parks the run and resumes it; a retry answers with the same
 * execution; who may run commands where; a workflow bound to a workspace's
 * setup event (ADR 0355) that the first turn waits for, that decides in a
 * kept workspace, and that runs again when the workspace is made again; and
 * the workspace events workflows react to.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_exec_${crypto.randomUUID().replaceAll("-", "")}`;
const tenantId = crypto.randomUUID();
const root: Identity = { tenantId, externalUserId: "root" };

const WORKFLOWS = `
export const execInChat = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ exec: Record<string, unknown> }>) =>
        host["catamorphic.sessions"].exec(input.exec as never, { state: { asked: true } }),
    }),
    defineBoundary({ run: ({ input }: BoundaryContext<unknown>) => input }),
  ],
}));

export const prepareChat = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["sessions:write"],
  triggers: [trigger("session.workspace-setup", {})],
  steps: [
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ id: string; payload: { sessionId: string } }>) =>
        host["catamorphic.sessions"].exec({
          sessionId: input.payload.sessionId,
          command: "cp \\"$WORK_PROGRAM/skills/review/SKILL.md\\" TRUSTED.md && chmod u+w TRUSTED.md",
          in: "setup",
          idempotencyKey: "trusted:" + input.id,
        }),
    }),
    defineBoundary({ run: ({ input }: BoundaryContext<unknown>) => input }),
  ],
}));
`;

/** The session kind as a host registers it. */
const workspaceSetup: TriggerKindRuntime = {
  name: WORKSPACE_SETUP_EVENT,
  modes: ["async"],
  payloadJsonSchema: { type: "object" },
  configJsonSchema: { type: "object" },
  validatePayload: () => ({ ok: true }),
  validateConfig: () => ({ ok: true }),
};

/** The Environment's setup command: whether the member's file is there. */
const SETUP_COMMAND =
  "(test -e notes/personal.env && echo present || echo absent) >> ../personal-seen; echo command >> ../setup-order";

/** The setup event each of `prepareChat`'s runs was started with, in order. */
const setupInputs: Array<Record<string, unknown>> = [];

/** The payload of a setup event a run received. */
function payloadOf(event: Record<string, unknown> | undefined) {
  const payload = event?.payload;
  return typeof payload === "object" && payload !== null ? payload : {};
}

/**
 * The workflow runtime, faked at the invocation: each boundary returns what
 * the real one would, so core's side runs for real.
 */
function invokeRuntime(invocation: {
  invocationId: string;
  exportName: string;
  stepIndex: number;
  input: unknown;
}): Promise<RuntimeInvocationReceipt> {
  const { exportName, stepIndex } = invocation;
  const value = ((invocation.input as { value?: unknown }).value ??
    {}) as Record<string, unknown>;
  const call = (args: unknown, state?: unknown) => ({
    type: "host_call",
    transition: {
      __catamorphicDurableTransition: "host_call",
      capability: "catamorphic.sessions",
      fn: "exec",
      args,
      ...(state === undefined ? {} : { statePresent: true, state }),
    },
  });
  if (stepIndex === 0 && exportName === "prepareChat") setupInputs.push(value);
  const result =
    stepIndex === 0 && exportName === "execInChat"
      ? call(value.exec, { asked: true })
      : stepIndex === 0 && exportName === "prepareChat"
        ? call({
            sessionId: (payloadOf(value) as { sessionId?: string }).sessionId,
            command:
              'cp "$WORK_PROGRAM/skills/review/SKILL.md" TRUSTED.md && chmod u+w TRUSTED.md; (test -e notes/personal.env && echo present || echo absent) >> ../hook-saw; echo trusted >> ../setup-order',
            in: "setup",
            idempotencyKey: `trusted:${String(value.id)}`,
          })
        : { type: "completed", output: value };
  return Promise.resolve({
    runtimeId: "fake-runtime",
    invocationId: invocation.invocationId,
    events: [],
    terminal: { status: "completed", result, steps: [] },
  });
}

/** The setup's own network in these tests (ADR 0257). */
const SETUP_EGRESS = {
  mode: "allowlist" as const,
  allow: ["registry.npmjs.org"],
};

/** What the machine was asked to do with sandboxes' networks. */
const network = Object.assign(
  [] as Array<{ kind: "widen" | "narrow"; sandboxId: string; id: string }>,
  { failNarrow: false, stopped: [] as string[] },
);
/** While set, another start places the program folder first (a race). */
const programRace: {
  placeFirst: boolean;
  /** Called as a start looks for its program's copy. */
  onLook?: () => Promise<void>;
} = { placeFirst: false };

describeIf("workflows run commands in a chat's workspace (ADR 0324)", () => {
  let tmpDir: string;
  let core: CatamorphicCore;
  let db: ReturnType<typeof createDatabase>;
  let projectId: string;
  /** `execInChat` as a project automation: whose runs a setup's are. */
  let projectEnablementId: string;
  const adapter = new RecordingAdapter();

  const writeAndDeploy = async (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files))
      await core.projects.writeFile(root, projectId, file, {
        content,
        commitMessage: `Write ${file}`,
      });
    const deployed = await core.deployment.deploy(
      tenantId,
      projectId,
      root.externalUserId,
      { message: "deploy" },
    );
    expect(deployed.status).toBe("deployed");
  };

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-exec-"));
    const machine = ownedSandboxes.track(
      new LocalProcessSandboxProvider({ root: path.join(tmpDir, "machine") }),
    );
    // The machine switches networks as ADR 0257's do; this one records it.
    const provider = new Proxy(machine, {
      get(target, property) {
        if (property === "widenEgress")
          return async (args: { sandboxId: string; id: string }) => {
            network.push({ kind: "widen", ...args });
          };
        if (property === "narrowEgress")
          return async (args: { sandboxId: string; id: string }) => {
            network.push({ kind: "narrow", ...args });
            if (network.failNarrow) throw new Error("the proxy is gone");
          };
        if (property === "stopSandbox")
          return async (sandboxId: string) => {
            network.stopped.push(sandboxId);
          };
        if (property === "executeCommand" && programRace.onLook)
          return async (
            sandboxId: string,
            command: string,
            options: { cwd?: string; timeout?: number },
          ) => {
            if (command.startsWith("test -d '../.work-program/"))
              await programRace.onLook?.();
            return target.executeCommand(sandboxId, command, options);
          };
        if (property === "executeCommand" && programRace.placeFirst)
          return async (
            sandboxId: string,
            command: string,
            options: { cwd?: string; timeout?: number },
          ) => {
            const racing =
              /chmod -R a-w '\.\.\/\.work-program\/\.staging-/.test(command)
                ? /'(\.\.\/\.work-program\/[0-9a-f]{40})'/.exec(command)?.[1]
                : undefined;
            const staging =
              /'(\.\.\/\.work-program\/\.staging-[0-9a-f-]+)'/.exec(
                command,
              )?.[1];
            // It lands between this start's look and its rename; the copy
            // stays writable, as permissions are to root (review images).
            return target.executeCommand(
              sandboxId,
              racing && staging
                ? command.replace(
                    "; else mv ",
                    `; else mkdir -p '${racing}' && echo first > '${racing}/.work-program-commit' && chmod -R u+w '${staging}' && mv `,
                  )
                : command,
              options,
            );
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) satisfies SandboxProvider;
    db = createDatabase({ connectionString, schema, poolSize: 8 });
    await migrateToLatest({ db, schema });
    const agent = {
      id: "worker",
      harness: { placement: "host" as const, adapter },
      topology: "controller" as const,
    };
    core = new CatamorphicCore({
      hostId: "exec-test-host",
      db,
      projectManager: new ProjectManager(
        new FsBackend(path.join(tmpDir, "dev")),
        new FsRemoteBackend(path.join(tmpDir, "origin")),
      ),
      sandboxProvider: provider,
      environmentProvider: testEnvironmentProvider(provider),
      triggerKinds: [workspaceSetup],
      credentialVault: new MemoryCredentialVault(),
      resolveMemberIdentity: async ({ tenantId, externalUserId }) => ({
        tenantId,
        externalUserId,
      }),
      codingAgent: {
        defaultAgentId: () => agent.id,
        get: (id) => (id === agent.id ? agent : undefined),
        list: () => [agent],
      },
    });
    // Workflow boundaries skip their runtime: the fake answers for them.
    vi.spyOn(core.runs, "invokeProductionRuntime").mockImplementation(
      (invocation) =>
        invokeRuntime({
          ...invocation,
          exportName: invocation.exportName ?? "",
          stepIndex: invocation.stepIndex ?? 0,
        }),
    );
    projectId = (await core.projects.create(root, { name: "Reviews" })).id;
    await writeAndDeploy({
      ".work/workflows/src/exec.ts": WORKFLOWS,
      ".work/skills/review/SKILL.md": "# Review\n\nThe trusted procedure.\n",
      "notes/hello.txt": "hello from the checkout\n",
    });
    const preview = await core.workflowEnablements.preview({
      identity: root,
      projectId,
      workflowName: "execInChat",
      owner: { type: "project" },
    });
    projectEnablementId = (
      await core.workflowEnablements.create({
        identity: root,
        projectId,
        workflowName: "execInChat",
        owner: { type: "project" },
        consentDigest: preview.consentDigest,
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    await cleanupTestResources(
      [
        () => core.runs.stopWorkers(),
        () => ownedSandboxes.cleanup(),
        () => sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db),
        () => db.destroy(),
      ],
      () => fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 }),
    );
  });

  const sessions = () => {
    if (!core.agentSessions) throw new Error("sessions not configured");
    return core.agentSessions;
  };
  const exec = () => {
    if (!core.sessionExec) throw new Error("exec not configured");
    return core.sessionExec;
  };
  const startWorkers = () =>
    core.runs.startWorker({
      kinds: ["durable_boundary", "host_call_wait"],
      concurrency: 2,
      pollIntervalMs: 5,
      leaseSeconds: 10,
    });

  /** Run `execInChat` with these arguments to its end; its final output. */
  async function runExec(
    args: Record<string, string | number>,
    remainingMs?: number,
  ) {
    const run = await core.runs.triggerProduction({
      identity: root,
      projectId,
      workflowName: "execInChat",
      input: { exec: args },
    });
    if (remainingMs !== undefined)
      await db
        .updateTable("workflow_step_attempts")
        .set({ started_at: new Date(Date.now() - 300_000 + remainingMs) })
        .where("run_id", "=", run.id)
        .execute();
    startWorkers();
    await expect
      .poll(
        async () =>
          (await core.runs.get({ identity: root, runId: run.id })).status,
        { timeout: 60_000, interval: 100 },
      )
      .toMatch(/completed|failed/);
    const done = await core.runs.get({ identity: root, runId: run.id });
    await core.runs.stopWorkers();
    return { run: done, runId: run.id };
  }

  /** A direct call, as a run's host call makes it. */
  const call = (input: {
    caller: Identity;
    runId: string;
    args: Record<string, unknown>;
    /** What is left of the attempt, by default all of it. */
    remainingMs?: number;
  }) =>
    exec().execute({
      caller: input.caller,
      projectId,
      runId: input.runId,
      author: {
        kind: "workflow",
        runId: input.runId,
        workflowName: "execInChat",
      },
      causation: [],
      signal: new AbortController().signal,
      deadlineAt: new Date(
        Date.now() + (input.remainingMs ?? 300_000),
      ).toISOString(),
      args: input.args,
    });

  /**
   * Stamp a run as the dispatcher stamps one a setup's event started for a
   * project automation (ADR 0355).
   */
  const stamp = (runId: string, event: string) =>
    db
      .updateTable("workflow_runs")
      .set({ event_id: event, workflow_enablement_id: projectEnablementId })
      .where("id", "=", runId)
      .execute();

  /** A setup under way, as `agent_sessions.setup_run` holds it. */
  const setupRun = (input: {
    event: string;
    deadlineMs: number;
    network?: boolean;
    kept?: boolean;
  }) =>
    JSON.stringify({
      event: input.event,
      network: input.network === true,
      kept: input.kept === true,
      requested: false,
      ownerAuthored: true,
      deadline: new Date(Date.now() + input.deadlineMs).toISOString(),
    });

  /** A project chat with a running workspace, mid-setup for `event`. */
  async function settingUp(input: { deadlineMs: number; network?: boolean }) {
    const sessionId = (
      await sessions().create(
        projectChatIdentity({ tenantId, projectId }),
        projectId,
      )
    ).id;
    await runExec({
      sessionId,
      in: "session",
      idempotencyKey: "start",
      command: "true",
    });
    const event = crypto.randomUUID();
    await db
      .updateTable("agent_sessions")
      .set({ setup_run: setupRun({ event, ...input }) })
      .where("id", "=", sessionId)
      .execute();
    const runId = (
      await core.runs.triggerProduction({
        identity: root,
        projectId,
        workflowName: "execInChat",
        input: { exec: {} },
      })
    ).id;
    await stamp(runId, event);
    const workspace = await sessions().personWorkspace({
      identity: root,
      projectId,
      sessionId,
      start: false,
    });
    return { sessionId, event, runId, workspace };
  }

  /** The setup's own network, as admission would give it (ADR 0257). */
  function onSetupNetwork() {
    const original = sessions().commandWorkspace.bind(sessions());
    return vi
      .spyOn(sessions(), "commandWorkspace")
      .mockImplementation(async (args) => {
        const found = await original(args);
        return found.setup && args.in === "setup"
          ? {
              ...found,
              setup: {
                ...found.setup,
                network: { egress: SETUP_EGRESS },
              },
            }
          : found;
      });
  }

  const actionOf = async (sessionId: string, idempotencyKey: string) =>
    db
      .selectFrom("session_actions")
      .selectAll()
      .where("session_id", "=", sessionId)
      .where("idempotency_key", "like", `%${idempotencyKey}%`)
      .executeTakeFirstOrThrow();

  it("runs in the chat's own sandbox, from its checkout, with the program read-only at $WORK_PROGRAM", async () => {
    const sessionId = (await sessions().create(root, projectId)).id;
    const { run } = await runExec({
      sessionId,
      in: "session",
      idempotencyKey: "look",
      command: [
        'basename "$PWD"',
        "cat notes/hello.txt",
        'cat "$WORK_PROGRAM/skills/review/SKILL.md"',
        '(echo changed >> "$WORK_PROGRAM/skills/review/SKILL.md") 2>/dev/null && echo writable || echo read-only',
        "echo oops >&2",
        "exit 3",
      ].join("\n"),
    });
    expect(run.status).toBe("completed");
    const { result, state } = run.result as {
      result: { exitCode: number; stdout: string; stderr: string };
      state: unknown;
    };
    expect(state).toEqual({ asked: true });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("project\n");
    expect(result.stdout).toContain("hello from the checkout");
    expect(result.stdout).toContain("The trusted procedure.");
    expect(result.stdout).toContain("read-only");
    expect(result.stderr).toBe("oops\n");
    // The chat's log says what ran, for people and the agent.
    const log = await db
      .selectFrom("agent_items")
      .select("text")
      .where("session_id", "=", sessionId)
      .execute();
    expect(
      log.some((item) =>
        /A workflow ran `basename "\$PWD"` \(and more lines\) in this chat's workspace: exit 3/.test(
          item.text ?? "",
        ),
      ),
    ).toBe(true);
    // The program is outside the checkout: nothing the chat saves carries it.
    const workspace = await sessions().personWorkspace({
      identity: root,
      projectId,
      sessionId,
      start: false,
    });
    const status = await workspace.provider.executeCommand(
      workspace.sandboxId,
      "git status --porcelain --untracked-files=all",
      { cwd: workspace.projectDirectory },
    );
    expect(status.result).not.toContain("work-program");
  }, 120_000);

  it("keeps the program folder another start placed first, never nesting its own copy inside", async () => {
    const sessionId = (await sessions().create(root, projectId)).id;
    programRace.placeFirst = true;
    try {
      const { run } = await runExec({
        sessionId,
        in: "session",
        idempotencyKey: "race",
        command: 'ls -A "$WORK_PROGRAM"',
      });
      expect(run.status).toBe("completed");
      const { result } = run.result as { result: { stdout: string } };
      expect(result.stdout).toContain(".work-program-commit");
      expect(result.stdout).not.toContain(".staging-");
    } finally {
      programRace.placeFirst = false;
    }
  });

  it("parks a command longer than its attempt, holding nothing, and resumes the run with its result", async () => {
    const sessionId = (await sessions().create(root, projectId)).id;
    // Little of the attempt is left: the command outlives it.
    const { run, runId } = await runExec(
      {
        sessionId,
        in: "session",
        idempotencyKey: "slow",
        command: "sleep 4; echo slept",
      },
      21_500,
    );
    expect(run.status).toBe("completed");
    expect(
      (run.result as { result: { stdout: string; exitCode: number } }).result,
    ).toMatchObject({ stdout: "slept\n", exitCode: 0 });
    const waits = await db
      .selectFrom("workflow_pauses")
      .select(["status", "wait_key"])
      .where("run_id", "=", runId)
      .execute();
    expect(waits).toEqual([
      { status: "resumed", wait_key: expect.stringMatching(/^session-exec:/) },
    ]);
  }, 120_000);

  it("answers a retry with the same execution instead of running it again", async () => {
    const sessionId = (await sessions().create(root, projectId)).id;
    const { runId } = await runExec({
      sessionId,
      in: "session",
      idempotencyKey: "warm",
      command: "true",
    });
    const args = {
      sessionId,
      in: "session",
      idempotencyKey: "once",
      command: "echo ran >> ../ran.log; wc -l < ../ran.log",
    };
    const first = await call({ caller: root, runId, args });
    const again = await call({ caller: root, runId, args });
    expect(again).toEqual(first);
    const count = await call({
      caller: root,
      runId,
      args: { ...args, idempotencyKey: "count", command: "wc -l < ../ran.log" },
    });
    expect((count as { stdout: string }).stdout.trim()).toBe("1");
    await expect(
      call({ caller: root, runId, args: { ...args, command: "echo other" } }),
    ).rejects.toThrow(/already used for another action/);
  }, 120_000);

  it("reaches only the chats a workspace is for, and setup only from a chat's setup run", async () => {
    const { runId } = await runExec({
      sessionId: (await sessions().create(root, projectId)).id,
      in: "session",
      idempotencyKey: "seed",
      command: "true",
    });
    const projectChat = (
      await sessions().create(
        projectChatIdentity({ tenantId, projectId }),
        projectId,
      )
    ).id;
    const memberChat = (await sessions().create(root, projectId)).id;
    const member = {
      tenantId,
      externalUserId: "ada",
      scope: [{ kind: "agent" as const, projectId, name: "*" }],
      executionScope: [{ projectId, name: "*" }],
    };
    const automation = (permissions: string[]): Identity => ({
      tenantId,
      externalUserId: "catamorphic:project",
      scope: [],
      projectPermissions: permissions.map((permission) => ({
        projectId,
        permission: permission as "sessions:write",
      })),
    });
    const args = (sessionId: string, idempotencyKey: string) => ({
      sessionId,
      in: "session",
      idempotencyKey,
      command: "true",
    });
    // A member's workflow reaches neither a project chat nor another's.
    await expect(
      call({ caller: member, runId, args: args(projectChat, "a") }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      call({ caller: member, runId, args: args(memberChat, "b") }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    // A project automation needs sessions:write, and reaches project chats.
    await expect(
      call({ caller: automation([]), runId, args: args(projectChat, "c") }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      call({
        caller: automation(["sessions:write"]),
        runId,
        args: args(memberChat, "d"),
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      call({
        caller: automation(["sessions:write"]),
        runId,
        args: args(projectChat, "e"),
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    // Setup's network is for the runs of the chat's setup event alone (ADR
    // 0257).
    await expect(
      call({
        caller: root,
        runId,
        args: { ...args(memberChat, "f"), in: "setup" },
      }),
    ).rejects.toThrow(/only from a run the chat's setup event started/);
  }, 120_000);

  it("runs in setup only for a project automation's run the dispatcher stamped with the setup event under way", async () => {
    const sessionId = (
      await sessions().create(
        projectChatIdentity({ tenantId, projectId }),
        projectId,
      )
    ).id;
    // The chat has a workspace, and Work is setting it up: its setup event
    // is `current`.
    await runExec({
      sessionId,
      in: "session",
      idempotencyKey: "start",
      command: "true",
    });
    const current = crypto.randomUUID();
    await db
      .updateTable("agent_sessions")
      .set({ setup_run: setupRun({ event: current, deadlineMs: 600_000 }) })
      .where("id", "=", sessionId)
      .execute();
    const setupArgs = (idempotencyKey: string) => ({
      sessionId,
      in: "setup",
      idempotencyKey,
      command: "echo in-setup",
    });
    const runOf = async (correlationKey?: string) =>
      (
        await core.runs.triggerProduction({
          identity: root,
          projectId,
          workflowName: "execInChat",
          input: { exec: {} },
          ...(correlationKey ? { correlationKey } : {}),
        })
      ).id;
    const refused = /only from a run the chat's setup event started/;
    // A caller's run labelled like the event's delivery is an ordinary run:
    // a delivery key is a label, and only the dispatcher writes the stamp.
    const lookalike = await runOf(`event:${crypto.randomUUID()}:${current}`);
    await expect(
      call({ caller: root, runId: lookalike, args: setupArgs("lookalike") }),
    ).rejects.toThrow(refused);
    // A run of an earlier setup's event is refused too.
    const stale = await runOf();
    await stamp(stale, crypto.randomUUID());
    await expect(
      call({ caller: root, runId: stale, args: setupArgs("stale") }),
    ).rejects.toThrow(refused);
    // So is a run the event started for anyone but the project: a member's
    // own automation hears the event and never runs commands in the setup.
    const members = await runOf();
    await db
      .updateTable("workflow_runs")
      .set({ event_id: current })
      .where("id", "=", members)
      .execute();
    await expect(
      call({ caller: root, runId: members, args: setupArgs("member") }),
    ).rejects.toThrow(refused);
    // A project automation's run stamped with the event under way may.
    const stamped = await runOf();
    await stamp(stamped, current);
    await expect(
      call({ caller: root, runId: stamped, args: setupArgs("current") }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "in-setup\n" });
    await core.runs.stopWorkers();
  }, 120_000);

  it("ends a setup command when the setup's time is up, and stops what a setup run started when it ends", async () => {
    const { sessionId, runId, event, workspace } = await settingUp({
      deadlineMs: 3_000,
    });
    const began = Date.now();
    await expect(
      call({
        caller: root,
        runId,
        args: {
          sessionId,
          in: "setup",
          idempotencyKey: "capped",
          command: "sleep 30",
          timeoutSeconds: 600,
        },
      }),
    ).resolves.toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - began).toBeLessThan(20_000);

    await db
      .updateTable("agent_sessions")
      .set({ setup_run: setupRun({ event, deadlineMs: 600_000 }) })
      .where("id", "=", sessionId)
      .execute();
    // Little of its attempt is left: the command parks, still running.
    await expect(
      call({
        caller: root,
        runId,
        remainingMs: 21_000,
        args: {
          sessionId,
          in: "setup",
          idempotencyKey: "left-running",
          command: "sleep 30; echo late > ../late",
        },
      }),
    ).rejects.toThrow(/waiting for session-exec:/);
    await exec().endSetup({
      tenantId,
      projectId,
      sessionId,
      event,
      network: false,
    });
    const stopped = await actionOf(sessionId, "left-running");
    expect(stopped.status).toBe("completed");
    expect(stopped.result).toMatchObject({
      exitCode: null,
      stderr: expect.stringContaining("The setup ended"),
    });
    const processes = await workspace.provider.processes?.listProcesses({
      sandboxId: workspace.sandboxId,
    });
    expect(
      processes?.find(
        (process) =>
          process.name === `work-exec-${stopped.id}` &&
          process.status === "running",
      ),
    ).toBeUndefined();
  }, 120_000);

  it("narrows after the last of parallel setup commands, refuses session commands while wide, and fails closed", async () => {
    const spy = onSetupNetwork();
    try {
      // The spy gives the setup its network; admission fixed none here.
      const { sessionId, runId, event, workspace } = await settingUp({
        deadlineMs: 600_000,
      });
      // Admission fixed the setup's egress on the chat's Allocation.
      await db
        .updateTable("execution_allocations")
        .set({
          policy_snapshot: sql`policy_snapshot || jsonb_build_object('sandbox', coalesce(policy_snapshot->'sandbox', '{}'::jsonb) || jsonb_build_object('setupEgress', ${JSON.stringify(SETUP_EGRESS)}::jsonb))`,
        })
        .where(
          "id",
          "=",
          db
            .selectFrom("agent_sessions")
            .select("allocation_id")
            .where("id", "=", sessionId),
        )
        .execute();
      network.length = 0;
      const setupCommand = (idempotencyKey: string, seconds: number) =>
        call({
          caller: root,
          runId,
          args: {
            sessionId,
            in: "setup",
            idempotencyKey,
            command: `sleep ${seconds}`,
          },
        });
      const long = setupCommand("long", 4);
      await expect.poll(() => network.length, { timeout: 10_000 }).toBe(1);
      const short = setupCommand("short", 1);
      await expect.poll(() => network.length, { timeout: 10_000 }).toBe(2);
      // A command in the session never runs on the setup's network.
      await expect(
        call({
          caller: root,
          runId,
          args: {
            sessionId,
            in: "session",
            idempotencyKey: "while-wide",
            command: "true",
          },
        }),
      ).rejects.toThrow(/setup's network/);
      await short;
      // The other still holds its widening: nothing narrowed yet.
      expect(network.map((entry) => entry.kind)).toEqual(["widen", "widen"]);
      await long;
      expect(network.map((entry) => entry.kind)).toEqual([
        "widen",
        "widen",
        "narrow",
      ]);
      // A sandbox that cannot be narrowed when the setup ends is stopped,
      // and the preparation does not go on.
      network.failNarrow = true;
      await expect(
        exec().endSetup({
          tenantId,
          projectId,
          sessionId,
          event,
          network: true,
        }),
      ).rejects.toThrow(/could not be returned to its Environment's network/);
      expect(network.stopped).toContain(workspace.sandboxId);
    } finally {
      network.failNarrow = false;
      spy.mockRestore();
    }
  }, 120_000);

  it("starts nothing for a setup that ended while it started, and keeps others off a sandbox the setup has on its network", async () => {
    const { sessionId, runId, workspace } = await settingUp({
      deadlineMs: 600_000,
    });
    // The setup ends between the command's look at it and its start.
    const original = sessions().commandWorkspace.bind(sessions());
    const ended = vi
      .spyOn(sessions(), "commandWorkspace")
      .mockImplementationOnce(async (args) => {
        const found = await original(args);
        await db
          .updateTable("agent_sessions")
          .set({ setup_run: null })
          .where("id", "=", sessionId)
          .execute();
        return found;
      });
    try {
      await expect(
        call({
          caller: root,
          runId,
          args: {
            sessionId,
            in: "setup",
            idempotencyKey: "raced",
            command: "echo started > raced.txt",
          },
        }),
      ).rejects.toThrow("The setup ended before the command started");
    } finally {
      ended.mockRestore();
    }
    const raced = await workspace.provider.executeCommand(
      workspace.sandboxId,
      "test -f raced.txt && echo started || echo nothing",
      { cwd: workspace.projectDirectory, timeout: 30 },
    );
    expect(raced.result.trim()).toBe("nothing");

    // The Environment's own setup holds the sandbox on its network: another
    // workflow's session command waits.
    const other = (
      await core.runs.triggerProduction({
        identity: root,
        projectId,
        workflowName: "execInChat",
        input: { exec: {} },
      })
    ).id;
    await db
      .updateTable("agent_sessions")
      .set({ setup_widened_until: sql<Date>`now() + interval '10 minutes'` })
      .where("id", "=", sessionId)
      .execute();
    await expect(
      call({
        caller: root,
        runId: other,
        args: {
          sessionId,
          in: "session",
          idempotencyKey: "while-setup-wide",
          command: "true",
        },
      }),
    ).rejects.toThrow(/setup's network/);
    await db
      .updateTable("agent_sessions")
      .set({ setup_widened_until: null })
      .where("id", "=", sessionId)
      .execute();
    await expect(
      call({
        caller: root,
        runId: other,
        args: {
          sessionId,
          in: "session",
          idempotencyKey: "once-narrow",
          command: "true",
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
  }, 120_000);

  it("orders network changes by the workspace, so a subagent's session command keeps its parent's setup narrow", async () => {
    const spy = onSetupNetwork();
    try {
      const { sessionId, runId } = await settingUp({ deadlineMs: 600_000 });
      await db
        .updateTable("execution_allocations")
        .set({
          policy_snapshot: sql`policy_snapshot || jsonb_build_object('sandbox', coalesce(policy_snapshot->'sandbox', '{}'::jsonb) || jsonb_build_object('setupEgress', ${JSON.stringify(SETUP_EGRESS)}::jsonb))`,
        })
        .where(
          "id",
          "=",
          db
            .selectFrom("agent_sessions")
            .select("allocation_id")
            .where("id", "=", sessionId),
        )
        .execute();
      // A subagent in the same workspace runs a long command there.
      const child = await sessions().createSubsession(
        root,
        projectId,
        sessionId,
        { task: "Watch the logs" },
      );
      expect(
        (
          await db
            .selectFrom("agent_sessions")
            .select("workspace_session_id")
            .where("id", "=", child.session.id)
            .executeTakeFirstOrThrow()
        ).workspace_session_id,
      ).toBe(sessionId);
      const other = (
        await core.runs.triggerProduction({
          identity: root,
          projectId,
          workflowName: "execInChat",
          input: { exec: {} },
        })
      ).id;
      const watching = call({
        caller: root,
        runId: other,
        args: {
          sessionId: child.session.id,
          in: "session",
          idempotencyKey: "child-watch",
          command: "sleep 3",
        },
      });
      await expect
        .poll(
          async () =>
            (
              await db
                .selectFrom("session_actions")
                .select("progress")
                .where("session_id", "=", child.session.id)
                .where("idempotency_key", "like", "%child-watch%")
                .executeTakeFirst()
            )?.progress,
          { timeout: 20_000 },
        )
        .toMatchObject({ phase: "running" });
      network.length = 0;
      // The parent's setup cannot widen the sandbox the child works in. The
      // child's own turns prepare the shared workspace meanwhile, and each
      // preparation narrows it first (fail closed), so only a widening
      // would be the setup's network.
      await expect(
        call({
          caller: root,
          runId,
          args: {
            sessionId,
            in: "setup",
            idempotencyKey: "widen-beside-child",
            command: "true",
          },
        }),
      ).rejects.toThrow(
        /A command in the session is running in this workspace/,
      );
      expect(
        network.filter((change) => change.kind === "widen"),
        JSON.stringify(network),
      ).toEqual([]);
      await watching;
    } finally {
      spy.mockRestore();
    }
  }, 120_000);

  it("says a command ran out of disk, and leaves no output files in the workspace (ADR 0336)", async () => {
    const sessionId = (await sessions().create(root, projectId)).id;
    const { run } = await runExec({
      sessionId,
      in: "session",
      idempotencyKey: "full",
      command: "echo 'npm ERR! code ENOSPC' >&2; exit 1",
    });
    const { result } = run.result as {
      result: { exitCode: number; outOfDisk?: string };
    };
    expect(result.exitCode).toBe(1);
    expect(result.outOfDisk).toBe(
      "The workspace ran out of disk space (no space left on device).",
    );
    // Its streams' files are gone once its result is kept.
    const action = await actionOf(sessionId, "full");
    const workspace = await sessions().personWorkspace({
      identity: root,
      projectId,
      sessionId,
      start: false,
    });
    const left = await workspace.provider.executeCommand(
      workspace.sandboxId,
      `test -e ../.work-session/exec/${action.id} && echo left || echo gone`,
      { cwd: workspace.projectDirectory },
    );
    expect(left.result.trim()).toBe("gone");
    // A command that failed for another reason says nothing of the disk.
    const { run: plain } = await runExec({
      sessionId,
      in: "session",
      idempotencyKey: "plain",
      command: "exit 2",
    });
    expect(
      (plain.result as { result: { outOfDisk?: string } }).result.outOfDisk,
    ).toBeUndefined();
  }, 120_000);

  it("names its program commit from the moment it starts, before it looks for its copy (ADR 0336)", async () => {
    const sessionId = (await sessions().create(root, projectId)).id;
    const named: Array<string | undefined> = [];
    programRace.onLook = async () => {
      const starting = await db
        .selectFrom("session_actions")
        .select("progress")
        .where("session_id", "=", sessionId)
        .where("operation", "=", "exec")
        .where("status", "=", "running")
        .executeTakeFirst();
      const progress = starting?.progress;
      named.push(
        progress && typeof progress === "object" && !Array.isArray(progress)
          ? String(progress.program ?? "")
          : undefined,
      );
    };
    try {
      const { run } = await runExec({
        sessionId,
        in: "session",
        idempotencyKey: "named",
        command: 'basename "$WORK_PROGRAM"',
      });
      const commit = (
        run.result as { result: { stdout: string } }
      ).result.stdout.trim();
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      // Both sides looked, and the start already named its commit: a
      // cleanup another start runs meanwhile keeps it.
      expect(named.length).toBeGreaterThan(0);
      expect(new Set(named)).toEqual(new Set([commit]));
    } finally {
      programRace.onLook = undefined;
    }
  }, 120_000);

  it("keeps a program copy a chat may still read, and removes it once none may (ADR 0336)", async () => {
    const sessionId = (await sessions().create(root, projectId)).id;
    const programOf = async (idempotencyKey: string) => {
      const { run } = await runExec({
        sessionId,
        in: "session",
        idempotencyKey,
        command: 'basename "$WORK_PROGRAM"',
      });
      return (
        run.result as { result: { stdout: string } }
      ).result.stdout.trim();
    };
    const workspace = await sessions().personWorkspace({
      identity: root,
      projectId,
      sessionId,
      start: true,
    });
    const copies = async () =>
      (
        await workspace.provider.executeCommand(
          workspace.sandboxId,
          "ls ../.work-program",
          { cwd: workspace.projectDirectory },
        )
      ).result
        .split("\n")
        .filter(Boolean)
        .sort();
    /** Its copy made, and every execution of it run, over a day ago. */
    const age = async (commit: string, hours: number) => {
      await workspace.provider.executeCommand(
        workspace.sandboxId,
        `touch -t 202601010000 ../.work-program/${commit}`,
        { cwd: workspace.projectDirectory },
      );
      await db
        .updateTable("session_actions")
        .set({ updated_at: new Date(Date.now() - hours * 3_600_000) })
        .where("session_id", "=", sessionId)
        .where("operation", "=", "exec")
        .where(sql<boolean>`progress->>'program' = ${commit}`)
        .execute();
    };
    const x = await programOf("keep-x");
    await age(x, 25);
    // A workflow runs at X again now, to hand its path to a turn: the old
    // copy is used now, and a cleanup at another commit keeps it.
    expect(await programOf("keep-x-again")).toBe(x);
    await writeAndDeploy({
      ".work/skills/review/SKILL.md": "# Review\n\nThe Y procedure.\n",
    });
    const y = await programOf("keep-y");
    expect(await copies()).toEqual([x, y].sort());
    // A turn that began before X was last handed over still works: kept.
    await age(x, 26);
    await db
      .insertInto("agent_turns")
      .values({
        session_id: sessionId,
        ordinal: 1,
        status: "waiting",
        created_at: new Date(Date.now() - 30 * 3_600_000),
      })
      .execute();
    await writeAndDeploy({
      ".work/skills/review/SKILL.md": "# Review\n\nThe Z procedure.\n",
    });
    const z = await programOf("keep-z");
    expect(await copies()).toEqual([x, y, z].sort());
    // Once no turn works and nothing used it for a day, it goes.
    await db
      .updateTable("agent_turns")
      .set({ status: "completed" })
      .where("session_id", "=", sessionId)
      .execute();
    await writeAndDeploy({
      ".work/skills/review/SKILL.md": "# Review\n\nThe W procedure.\n",
    });
    const w = await programOf("keep-w");
    expect(await copies()).toEqual([y, z, w].sort());
    // A turn waiting for days keeps nothing older than a week.
    await age(y, 8 * 24);
    await db
      .updateTable("agent_turns")
      .set({
        status: "waiting",
        created_at: new Date(Date.now() - 9 * 24 * 3_600_000),
      })
      .where("session_id", "=", sessionId)
      .execute();
    await writeAndDeploy({
      ".work/skills/review/SKILL.md": "# Review\n\nThe V procedure.\n",
    });
    const v = await programOf("keep-v");
    expect(await copies()).toEqual([z, w, v].sort());
    await db
      .updateTable("agent_turns")
      .set({ status: "completed" })
      .where("session_id", "=", sessionId)
      .execute();
    // The project's program as the other cases expect it.
    await writeAndDeploy({
      ".work/skills/review/SKILL.md": "# Review\n\nThe trusted procedure.\n",
    });
  }, 180_000);

  it("masks the chat's secret values in what a command prints", async () => {
    const sessionId = (await sessions().create(root, projectId)).id;
    if (!core.secrets) throw new Error("secrets not configured");
    await core.secrets.rememberDelivery({
      tenantId,
      sessionId,
      variables: { DEPLOY_TOKEN: "tok-0123456789abcdef" },
    });
    const { run } = await runExec({
      sessionId,
      in: "session",
      idempotencyKey: "leak",
      command: "echo tok-0123456789abcdef; echo tok-0123456789abcdef >&2",
    });
    const { result } = run.result as {
      result: { stdout: string; stderr: string };
    };
    expect(result.stdout).toBe("[secret DEPLOY_TOKEN]\n");
    expect(result.stderr).toBe("[secret DEPLOY_TOKEN]\n");
    const stored = await actionOf(sessionId, "leak");
    expect(JSON.stringify(stored.result)).not.toContain("tok-0123456789abcdef");
  }, 120_000);

  it("keeps each commit's program in its own folder, and never runs a command twice when a start is taken over", async () => {
    const sessionId = (await sessions().create(root, projectId)).id;
    const programOf = async (idempotencyKey: string) => {
      const { run } = await runExec({
        sessionId,
        in: "session",
        idempotencyKey,
        command:
          'basename "$WORK_PROGRAM"; cat "$WORK_PROGRAM/skills/review/SKILL.md"',
      });
      return (run.result as { result: { stdout: string } }).result.stdout;
    };
    const first = await programOf("program-a");
    await writeAndDeploy({
      ".work/skills/review/SKILL.md": "# Review\n\nThe revised procedure.\n",
    });
    const second = await programOf("program-b");
    const [commitA] = first.split("\n");
    const [commitB] = second.split("\n");
    expect(commitA).toMatch(/^[0-9a-f]{40}$/);
    expect(commitB).toMatch(/^[0-9a-f]{40}$/);
    expect(commitB).not.toBe(commitA);
    expect(first).toContain("The trusted procedure.");
    expect(second).toContain("The revised procedure.");
    const workspace = await sessions().personWorkspace({
      identity: root,
      projectId,
      sessionId,
      start: false,
    });
    const listed = await workspace.provider.executeCommand(
      workspace.sandboxId,
      "ls ../.work-program",
      { cwd: workspace.projectDirectory },
    );
    expect(listed.result.split("\n").filter(Boolean).sort()).toEqual(
      [commitA, commitB].sort(),
    );

    // A start whose replica died after the process began: the next adopts
    // the process instead of running the command again.
    const { runId } = await runExec({
      sessionId,
      in: "session",
      idempotencyKey: "warm",
      command: "true",
    });
    await expect(
      call({
        caller: root,
        runId,
        remainingMs: 21_000,
        args: {
          sessionId,
          in: "session",
          idempotencyKey: "once-only",
          command: "echo ran >> ../adopt.log; sleep 3; echo done",
        },
      }),
    ).rejects.toThrow(/waiting for session-exec:/);
    const action = await actionOf(sessionId, "once-only");
    await db
      .updateTable("session_actions")
      .set({
        progress: JSON.stringify({
          phase: "starting",
          at: new Date(Date.now() - 600_000).toISOString(),
        }),
      })
      .where("id", "=", action.id)
      .execute();
    for (;;) {
      const outcome = await exec().follow({
        waitKey: `session-exec:${action.id}`,
        signal: new AbortController().signal,
        sliceMs: 10_000,
      });
      if (outcome.status === "pending") continue;
      expect(outcome).toMatchObject({
        status: "done",
        output: { stdout: "done\n", exitCode: 0 },
      });
      break;
    }
    const ran = await workspace.provider.executeCommand(
      workspace.sandboxId,
      "wc -l < ../adopt.log",
      { cwd: workspace.projectDirectory },
    );
    expect(ran.result.trim()).toBe("1");
  }, 120_000);

  it("waits for the workflows bound to a workspace's setup event before a chat's first turn, lets them decide in a kept workspace, and sets up again in one made again (ADR 0355)", async () => {
    const manifest = (command: string) => ({
      [PROJECT_MANIFEST_PATH]: JSON.stringify({
        environments: {
          dev: {
            workloads: ["agent", "workflow"],
            personalCredentials: true,
            setup: { command },
          },
        },
        defaultEnvironment: "dev",
      }),
    });
    await writeAndDeploy(manifest(SETUP_COMMAND));
    const preview = await core.workflowEnablements.preview({
      identity: root,
      projectId,
      workflowName: "prepareChat",
      owner: { type: "project" },
    });
    await core.workflowEnablements.create({
      identity: root,
      projectId,
      workflowName: "prepareChat",
      owner: { type: "project" },
      consentDigest: preview.consentDigest,
    });
    // The member keeps a personal file; it never meets a setup run.
    await core.personalEnvironments.replace({
      identity: root,
      projectId,
      input: {
        files: [
          {
            path: "notes/personal.env",
            content: Buffer.from("PERSONAL=1\n").toString("base64"),
          },
        ],
      },
    });
    startWorkers();
    const dispatcher = startEventDispatcher({ core, pollEveryMs: 25 });
    try {
      const sessionId = (await sessions().create(root, projectId)).id;
      const sent = await sessions().sendMessage(
        root,
        projectId,
        sessionId,
        "Review it",
      );
      expect(sent.turn.status).toBe("completed");
      // The turn waited for it: the Environment's command ran, then the
      // event's run put the trusted file in place.
      const workspace = await sessions().personWorkspace({
        identity: root,
        projectId,
        sessionId,
        start: false,
      });
      const inWorkspace = async (command: string) =>
        (
          await workspace.provider.executeCommand(
            workspace.sandboxId,
            command,
            { cwd: workspace.projectDirectory },
          )
        ).result;
      expect(await inWorkspace("cat TRUSTED.md")).toMatch(
        /The (trusted|revised) procedure\./,
      );
      expect(await inWorkspace("cat ../setup-order")).toBe(
        "command\ntrusted\n",
      );
      const first = setupInputs.at(-1);
      expect(first).toMatchObject({
        source: "session",
        kind: "session.workspace-setup",
      });
      expect(payloadOf(first)).toMatchObject({
        sessionId,
        session: { id: sessionId, key: null },
        detail: {
          reason: "created",
          environment: "dev",
          // Every chat stands on a base (ADR 0344): here the project's main.
          workspace: {
            ref: "main",
            commit: expect.stringMatching(/^[0-9a-f]{40}$/),
          },
          previous: null,
          sandbox: "new",
        },
      });
      expect(payloadOf(first)).toHaveProperty("agentId");
      const base = (
        payloadOf(first) as { detail: { workspace: { commit: string } } }
      ).detail.workspace.commit;
      // Nothing is left that would let a later run use the setup's network.
      const row = await db
        .selectFrom("agent_sessions")
        .select(["setup_run", "workspace_generation"])
        .where("id", "=", sessionId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ setup_run: null, workspace_generation: 1 });
      // The dispatcher stamped its run with the event; no label carries it.
      const setupRuns = await db
        .selectFrom("workflow_runs")
        .select(["event_id", "status", "correlation_key"])
        .where("workflow_name", "=", "prepareChat")
        .execute();
      expect(setupRuns).toEqual([
        {
          event_id: String(first?.id),
          status: "completed",
          correlation_key: null,
        },
      ]);
      const recorded = await db
        .selectFrom("project_events")
        .select(["id", "waited"])
        .where("project_id", "=", projectId)
        .where("kind", "=", "session.workspace-setup")
        .execute();
      expect(recorded).toEqual([{ id: String(first?.id), waited: true }]);

      // A second turn in the same workspace sets nothing up again.
      const before = setupInputs.length;
      await sessions().sendMessage(root, projectId, sessionId, "Again");
      expect(setupInputs.length).toBe(before);

      // The setup's command changes. The workspace is one the chat already
      // set up, so Work runs nothing there by itself: the event says it is
      // kept and what it last set up on, and the workflow decides. The
      // member's file, there by now, is taken out first and back after.
      await writeAndDeploy(
        manifest(`${SETUP_COMMAND}; echo v2 >> ../setup-order`),
      );
      await sessions().sendMessage(root, projectId, sessionId, "Changed");
      expect(payloadOf(setupInputs.at(-1))).toMatchObject({
        sessionId,
        detail: {
          reason: "changed",
          previous: { commit: base },
          sandbox: "kept",
        },
      });
      expect(await inWorkspace("cat ../setup-order")).toBe(
        "command\ntrusted\ntrusted\n",
      );
      expect(
        await inWorkspace(
          "cat ../personal-seen; cat ../hook-saw; cat notes/personal.env",
        ),
      ).toBe("absent\nabsent\nabsent\nPERSONAL=1\n");
      // Recorded done for the changed command: nothing is due next turn.
      const kept = setupInputs.length;
      await sessions().sendMessage(root, projectId, sessionId, "Still here");
      expect(setupInputs.length).toBe(kept);

      // The workspace goes with its machine, as node recovery records it:
      // the next is set up again, command first.
      const { allocation_id } = await db
        .selectFrom("agent_sessions")
        .select("allocation_id")
        .where("id", "=", sessionId)
        .executeTakeFirstOrThrow();
      await new ExecutionAllocationsService(db).release({
        identity: root,
        allocationId: allocation_id ?? "",
        reason: "node_lost",
      });
      await recordWorkspaceGone({
        db,
        sessionId,
        change: "lost",
        reason: "machine-lost",
      });
      await sessions().sendMessage(root, projectId, sessionId, "Once more");
      expect(payloadOf(setupInputs.at(-1))).toMatchObject({
        sessionId,
        detail: { reason: "rebuilt", previous: null, sandbox: "new" },
      });
      const again = await sessions().personWorkspace({
        identity: root,
        projectId,
        sessionId,
        start: false,
      });
      expect(again.sandboxId).not.toBe(workspace.sandboxId);
      expect(
        (
          await again.provider.executeCommand(
            again.sandboxId,
            "cat ../setup-order",
            { cwd: again.projectDirectory },
          )
        ).result,
      ).toBe("command\nv2\ntrusted\n");

      const events = await db
        .selectFrom("project_events")
        .select(["payload"])
        .where("project_id", "=", projectId)
        .where("kind", "=", "session.workspace-changed")
        .orderBy("sequence")
        .execute();
      const mine = events
        .map((event) => event.payload as { sessionId: string; detail: unknown })
        .filter((payload) => payload.sessionId === sessionId)
        .map((payload) => payload.detail);
      expect(mine).toEqual([
        expect.objectContaining({
          change: "ready",
          reason: "created",
          generation: 1,
        }),
        expect.objectContaining({ change: "lost", reason: "machine-lost" }),
        expect.objectContaining({
          change: "rebuilt",
          reason: "machine-lost",
          generation: 2,
        }),
      ]);
    } finally {
      await dispatcher.stop();
      await core.runs.stopWorkers();
    }
  }, 180_000);
});
