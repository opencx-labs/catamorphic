import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type { RuntimeInvocationReceipt } from "@catamorphic/sandbox";
import {
  cleanupTestResources,
  TestSandboxes,
} from "@catamorphic/sandbox/testing";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { projectChatIdentity } from "../services/chat-delivery.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { recordWorkspaceGone } from "../services/workspace-events.js";
import { RecordingAdapter } from "./recording-adapter.js";
import { testEnvironmentProvider } from "./test-environment.js";

const ownedSandboxes = new TestSandboxes();

/*
 * Workflows run commands in a chat's workspace (ADR 0324), on real
 * local-process sandboxes: `exec` in the chat's own sandbox, seeing its
 * checkout and a read-only copy of the program; a command longer than its
 * attempt parks the run and resumes it; a retry answers with the same
 * execution; who may run commands where; a setup workflow that runs before
 * a chat's first turn and again when its workspace is made again; and the
 * workspace events workflows react to.
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
  steps: [
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ sessionId: string; reason: string }>) =>
        host["catamorphic.sessions"].exec({
          sessionId: input.sessionId,
          command: "cp \\"$WORK_PROGRAM/skills/review/SKILL.md\\" TRUSTED.md && chmod u+w TRUSTED.md",
          in: "setup",
          idempotencyKey: "trusted",
        }),
    }),
    defineBoundary({ run: ({ input }: BoundaryContext<unknown>) => input }),
  ],
}));
`;

/** What each setup run was started with, in order. */
const setupInputs: Array<Record<string, unknown>> = [];

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
            sessionId: value.sessionId,
            command:
              'cp "$WORK_PROGRAM/skills/review/SKILL.md" TRUSTED.md && chmod u+w TRUSTED.md',
            in: "setup",
            idempotencyKey: `trusted-${String(value.reason)}`,
          })
        : { type: "completed", output: value };
  return Promise.resolve({
    runtimeId: "fake-runtime",
    invocationId: invocation.invocationId,
    events: [],
    terminal: { status: "completed", result, steps: [] },
  });
}

describeIf("workflows run commands in a chat's workspace (ADR 0324)", () => {
  let tmpDir: string;
  let core: CatamorphicCore;
  let db: ReturnType<typeof createDatabase>;
  let projectId: string;
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
    const provider = ownedSandboxes.track(
      new LocalProcessSandboxProvider({ root: path.join(tmpDir, "machine") }),
    );
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
      deadlineAt: new Date(Date.now() + 300_000).toISOString(),
      args: input.args,
    });

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
    // Setup's network is for the chat's own setup run alone (ADR 0257).
    await expect(
      call({
        caller: root,
        runId,
        args: { ...args(memberChat, "f"), in: "setup" },
      }),
    ).rejects.toThrow(/only from the chat's setup workflow/);
  }, 120_000);

  it("runs a setup workflow before a chat's first turn and again in a workspace made again, and reports the workspace's changes", async () => {
    await writeAndDeploy({
      [PROJECT_MANIFEST_PATH]: JSON.stringify({
        environments: {
          dev: {
            workloads: ["agent", "workflow"],
            setup: {
              command: "echo command >> ../setup-order",
              workflow: "prepareChat",
            },
          },
        },
        defaultEnvironment: "dev",
      }),
    });
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
    startWorkers();
    const sessionId = (await sessions().create(root, projectId)).id;
    const sent = await sessions().sendMessage(
      root,
      projectId,
      sessionId,
      "Review it",
    );
    expect(sent.turn.status).toBe("completed");
    // The turn waited for it: the trusted file was in place first.
    const workspace = await sessions().personWorkspace({
      identity: root,
      projectId,
      sessionId,
      start: false,
    });
    const read = await workspace.provider.executeCommand(
      workspace.sandboxId,
      "cat TRUSTED.md && cat ../setup-order",
      { cwd: workspace.projectDirectory },
    );
    expect(read.result).toContain("The trusted procedure.");
    expect(read.result).toContain("command");
    expect(setupInputs.at(-1)).toMatchObject({
      sessionId,
      key: null,
      reason: "created",
      workspace: null,
    });
    expect(setupInputs.at(-1)).toHaveProperty("agentId");
    // Nothing is left that would let a later run use the setup's network.
    const row = await db
      .selectFrom("agent_sessions")
      .select(["setup_run", "workspace_generation"])
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ setup_run: null, workspace_generation: 1 });

    // A second turn in the same workspace sets nothing up again.
    const before = setupInputs.length;
    await sessions().sendMessage(root, projectId, sessionId, "Again");
    expect(setupInputs.length).toBe(before);

    // The workspace goes with its machine, as node recovery records it:
    // the next is set up again.
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
    expect(setupInputs.at(-1)).toMatchObject({ sessionId, reason: "rebuilt" });
    await core.runs.stopWorkers();

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
  }, 180_000);
});
