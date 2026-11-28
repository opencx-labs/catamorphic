import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SETTLED_TURN_STATUSES } from "@catamorphic/agent-protocol";
import type { DB, Json } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import {
  type EnvironmentRuntimeBinding,
  SANDBOX_CAPABILITIES,
  type SandboxEgress,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import {
  cleanupTestResources,
  TestSandboxes,
} from "@catamorphic/sandbox/testing";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Identity, PROJECT_PRINCIPAL_ID } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ConnectionAdmissionService } from "../services/connection-admission.js";
import { ConnectionCapabilityGrantsService } from "../services/connection-capability-grants.js";
import type { ResolvedConnectionBinding } from "../services/connection-types.js";
import type { ConnectionsService } from "../services/connections-service.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { HostCallParkedError } from "../services/host-call-waits.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import type { RunsService } from "../services/runs-service.js";
import { SecretsService } from "../services/secrets-service.js";
import { SessionExecService } from "../services/session-exec.js";
import { SessionWorkspaces } from "../services/session-workspaces.js";
import { changedPaths } from "../services/sessions/changed-paths.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";
import { TriggersService } from "../services/triggers-service.js";
import { WaitedEventsService } from "../services/waited-events.js";
import { WorkspaceCheckoutsService } from "../services/workspace-checkouts.js";
import { WORKSPACE_SETUP_EVENT } from "../services/workspace-events.js";
import { parseSetupRecord } from "../services/workspace-setup.js";
import { RecordingAdapter } from "./recording-adapter.js";
import { startCheckoutGateway } from "./test-checkout-gateway.js";

const ownedSandboxes = new TestSandboxes();

/**
 * A setup on its own network (ADR 0257), end to end: in a chat at a ref of
 * the project's remote, the Environment's setup runs widened to its own
 * hosts alone, in a sandbox holding the base checkout and nothing else
 * (no saved work, grant, gateway variable or secret it does not name);
 * once narrow again, the session's work, grants, secrets and files arrive
 * for the agent. Idle release, a failed setup, a fork, and a preparation
 * that stopped while replacing a sandbox all keep that.
 */

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (
    await execFileAsync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      ...args,
    ])
  ).stdout.trim();

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_setup_network";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "ada",
};
const GATEWAY_HOST = "work.acme.test:80";
const LOGS_CONNECTION = "22222222-2222-4222-8222-222222222222";

/** A connection the chat's Environment binds: an HTTP API for code. */
class LogsAdmission extends ConnectionAdmissionService {
  override async admit(): Promise<ResolvedConnectionBinding[]> {
    return [
      {
        connectionId: LOGS_CONNECTION,
        alias: "logs",
        providerKind: "logs-api",
        principalKind: "project_service",
        capabilities: ["get"],
      },
    ];
  }
}

describe("a setup on its own network, end to end (ADR 0257)", () => {
  let tmpDir: string;
  let runs: string;
  let projectId: string;
  let projectManager: ProjectManager;
  let sessions: AgentSessionsService;
  let machine: LocalProcessSandboxProvider;
  let gateway: Awaited<ReturnType<typeof startCheckoutGateway>>;
  const allocations = new ExecutionAllocationsService(db);
  /** What the agent found in its project folder, turn by turn. */
  const found: string[] = [];
  const adapter = new RecordingAdapter({
    // The agent reads what it gathered, then gathers some (rows a query
    // through the gateway returned, say).
    before: async (attempt) => {
      const sandbox = await sandboxOf(attempt.sessionId);
      const seen = await machine.executeCommand(
        sandbox,
        "cat notes/rows.json 2>/dev/null || echo no rows; ls ../.work-session/grants",
        { cwd: "/workspace/project" },
      );
      found.push(seen.result.trim().replaceAll("\n", " "));
      await machine.executeCommand(
        sandbox,
        "mkdir -p notes && echo prod-rows > notes/rows.json",
        { cwd: "/workspace/project" },
      );
    },
  });

  /** One line per event: switches, and what each setup saw. */
  const ranLines = async () =>
    (await fs.readFile(runs, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);

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

  const writeManifest = async (setup: string) => {
    const repo = await projectManager.open(identity.tenantId, projectId);
    try {
      await repo.writeFile(
        PROJECT_MANIFEST_PATH,
        JSON.stringify({
          secrets: { SETUP_TOKEN: {}, OTHER_SECRET: {} },
          environments: {
            review: {
              workloads: ["agent"],
              network: { egress: "gateway" },
              secrets: ["SETUP_TOKEN", "OTHER_SECRET"],
              setup: {
                command: setup,
                network: { allow: ["registry.npmjs.org"] },
                secrets: ["SETUP_TOKEN"],
              },
            },
          },
          defaultEnvironment: "review",
        }),
      );
      await repo.commit("Environment", {
        name: "Test",
        email: "test@example.com",
      });
    } finally {
      await repo.dispose();
    }
  };

  /** A setup that writes what it sees, and fails while `flag` exists. */
  const probe = (version: string, flag?: string) =>
    [
      `rows=$([ -f notes/rows.json ] && echo yes || echo no)`,
      `grants=$(ls ../.work-session/grants 2>/dev/null | wc -l | tr -d ' ')`,
      `files=$(ls ../.work-session/env 2>/dev/null | wc -l | tr -d ' ')`,
      `http=$(env | grep -c '^WORK_HTTP_' || true)`,
      `echo "setup ${version}: rows=$rows grants=$grants env=$files http=$http token=\${SETUP_TOKEN:-none} other=\${OTHER_SECRET:-none} base=$(cat README.md)" >> '${runs}'`,
      ...(flag ? [`if [ -f '${flag}' ]; then exit 3; fi`] : []),
    ].join("\n");

  const send = async (sessionId: string, text: string) => {
    const result = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      text,
    );
    expect(result.turn.status).toBe("completed");
    return adapter.lastInput() ?? "";
  };

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-network-"));
    runs = path.join(tmpDir, "runs.log");
    // The project's linked remote: the pull request's code.
    const seed = path.join(tmpDir, "seed");
    await fs.mkdir(seed);
    await git(seed, ["init", "-q", "-b", "main"]);
    await fs.writeFile(path.join(seed, "README.md"), "main\n");
    await git(seed, ["add", "."]);
    await git(seed, ["commit", "-q", "-m", "main"]);
    const remote = path.join(tmpDir, "remote.git");
    await execFileAsync("git", ["clone", "-q", "--bare", seed, remote]);

    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    projectId = (await projects.create(identity, { name: "Reviews" })).id;
    await db
      .updateTable("projects")
      .set({ remote_url: remote, remote_ownership: "attached" })
      .where("id", "=", projectId)
      .execute();
    await writeManifest(probe("v1"));
    await db
      .insertInto("connections")
      .values({
        id: LOGS_CONNECTION,
        tenant_id: identity.tenantId,
        project_id: projectId,
        provider_kind: "logs-api",
        principal_kind: "project_service",
        label: "Logs",
        name: "logs",
      })
      .execute();

    machine = ownedSandboxes.track(
      new LocalProcessSandboxProvider({
        root: path.join(tmpDir, "machine"),
        acceptUnenforcedEgress: true,
      }),
    );
    // The machine writes each switch beside what setup writes.
    const switching = new Proxy(machine, {
      get(target, property) {
        if (property === "widenEgress")
          return async (args: { egress: SandboxEgress }) => {
            await fs.appendFile(
              runs,
              `widen ${args.egress.mode === "allowlist" ? args.egress.allow.join(",") : "open"}\n`,
            );
          };
        if (property === "narrowEgress")
          return async () => {
            await fs.appendFile(runs, "narrow\n");
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) satisfies SandboxProvider;
    const binding: EnvironmentRuntimeBinding = {
      descriptor: {
        id: "machine",
        label: "Machine",
        trust: "managed",
        isolation: "sandbox",
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: [
          SANDBOX_CAPABILITIES.egressPolicy,
          SANDBOX_CAPABILITIES.setupNetwork,
        ],
        resources: {},
      },
      sandboxProvider: switching,
    };
    const projectEnvironments = new ProjectEnvironmentsService(
      db,
      projectManager,
    );
    const secrets = new SecretsService({
      db,
      vault: new MemoryCredentialVault(),
      environments: projectEnvironments,
    });
    for (const [name, value] of [
      ["SETUP_TOKEN", "setup-token-value"],
      ["OTHER_SECRET", "other-secret-value"],
    ] as const)
      await secrets.upsert({ identity, projectId, name, value });
    const agent: RegisteredCodingAgent = {
      id: "reviewer",
      harness: { placement: "host", adapter },
      topology: "controller",
      connectionRequirements: ["logs"],
    };
    // Each checkout's start and end is written beside the switches, so
    // the order they happen in shows.
    const serving = new WorkspaceCheckoutsService(db, { projectManager });
    const checkouts = new Proxy(serving, {
      get(target, property) {
        if (property === "issue")
          return async (args: Parameters<typeof serving.issue>[0]) => {
            await fs.appendFile(runs, "checkout open\n");
            return target.issue(args);
          };
        if (property === "revoke")
          return async (args: Parameters<typeof serving.revoke>[0]) => {
            await target.revoke(args);
            await fs.appendFile(runs, "checkout ended\n");
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    gateway = await startCheckoutGateway(() => serving);
    sessions = new AgentSessionsService(db, {
      hostId: "setup-network-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        projectEnvironments,
        {
          get: ({ allocationBindingId }) =>
            !allocationBindingId || allocationBindingId === "machine"
              ? binding
              : undefined,
        },
        undefined,
        { gatewayHosts: [GATEWAY_HOST] },
      ),
      executionAllocations: allocations,
      codingAgents: {
        defaultAgentId: () => agent.id,
        get: (id) => (id === agent.id ? agent : undefined),
        list: () => [agent],
      },
      workspaces: new SessionWorkspaces({
        projectManager,
        origin: async () => ({ url: remote }),
      }),
      connectionAdmission: new LogsAdmission(
        undefined as unknown as ConnectionsService,
      ),
      connectionGrants: new ConnectionCapabilityGrantsService(db, allocations),
      connectionMcpUrl: () => "http://work.acme.test/mcp",
      // The base is fetched from Work itself, through a gateway the
      // sandbox really reaches (ADR 0353).
      checkouts,
      sandboxGateway: {
        url: () => gateway.url,
        remoteBaseUrls: () => undefined,
        modelApi: () => undefined,
        servesHttp: () => true,
      },
      secrets,
    });
  }, 60_000);

  afterAll(async () => {
    await cleanupTestResources(
      [
        () => sessions?.stopLocalTurns(),
        () => ownedSandboxes.cleanup(),
        () => gateway?.close(),
        () => db.destroy(),
      ],
      () => fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 }),
    );
  });

  it("widens a new sandbox holding its base alone, then the agent gets its work back", async () => {
    const chat = await sessions.create(identity, projectId, {
      workspace: { ref: "main" },
    });
    await send(chat.id, "review");
    // The base is fetched while the sandbox reaches only the gateway, and
    // its checkout has ended before the network changes (ADR 0353). Then
    // widened to the setup's hosts alone (not the gateway), with nothing
    // but the base checkout and the one secret it names.
    expect(await ranLines()).toEqual([
      "checkout open",
      "checkout ended",
      "widen registry.npmjs.org",
      "setup v1: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=main",
      "narrow",
    ]);
    // Once narrow: fresh grants and the gateway's variables for the agent.
    const first = await sandboxOf(chat.id);
    expect(found.at(-1)).toBe("no rows logs");
    const gateway = await machine.executeCommand(
      first,
      "cat ../.work-session/env/gateway.sh",
      { cwd: "/workspace/project" },
    );
    expect(gateway.result).toContain("WORK_HTTP_LOGS");

    // A later turn in the same sandbox: narrowed first, nothing widens.
    await send(chat.id, "again");
    expect((await ranLines()).slice(5)).toEqual(["narrow"]);
    expect(found.at(-1)).toBe("prod-rows logs");
  }, 60_000);

  it("keeps what the agent gathered from the next setup after idle release, and gives it back", async () => {
    await fs.rm(runs, { force: true });
    const chat = await sessions.create(identity, projectId, {
      workspace: { ref: "main" },
    });
    await send(chat.id, "gather");
    const first = await sandboxOf(chat.id);
    const { allocation_id } = await db
      .selectFrom("agent_sessions")
      .select("allocation_id")
      .where("id", "=", chat.id)
      .executeTakeFirstOrThrow();
    await allocations.release({
      identity,
      allocationId: allocation_id ?? "",
      reason: "idle",
    });
    await send(chat.id, "after idle");
    expect(await sandboxOf(chat.id)).not.toBe(first);
    expect((await ranLines()).slice(5)).toEqual([
      "checkout open",
      "checkout ended",
      "widen registry.npmjs.org",
      "setup v1: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=main",
      "narrow",
    ]);
    // The rows the agent wrote in its first turn are back for it.
    expect(found.at(-1)).toBe("prod-rows logs");
  }, 60_000);

  it("replaces a used sandbox to set up again, even after a failed setup, and keeps rows out of it", async () => {
    await fs.rm(runs, { force: true });
    const flag = path.join(tmpDir, "fail");
    const chat = await sessions.create(identity, projectId, {
      workspace: { ref: "main" },
    });
    await send(chat.id, "gather");
    const first = await sandboxOf(chat.id);
    // The command changes and its setup fails: a new sandbox, base alone.
    await fs.writeFile(flag, "");
    await writeManifest(probe("v2", flag));
    const failed = await send(chat.id, "with a failing setup");
    expect(failed).toContain("failed with exit code 3");
    const second = await sandboxOf(chat.id);
    expect(second).not.toBe(first);
    expect(found.at(-1)).toBe("prod-rows logs");
    // It runs again in yet another sandbox, still without the rows.
    await fs.rm(flag);
    await send(chat.id, "fixed");
    expect(await sandboxOf(chat.id)).not.toBe(second);
    expect((await ranLines()).slice(5)).toEqual([
      "narrow",
      "checkout open",
      "checkout ended",
      "widen registry.npmjs.org",
      "setup v2: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=main",
      "narrow",
      "narrow",
      "checkout open",
      "checkout ended",
      "widen registry.npmjs.org",
      "setup v2: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=main",
      "narrow",
    ]);
    expect(found.at(-1)).toBe("prod-rows logs");
  }, 60_000);

  it("sets up a fork on its own network too: every chat stands on a base (ADR 0344)", async () => {
    await fs.rm(runs, { force: true });
    await writeManifest(probe("v3"));
    const chat = await sessions.create(identity, projectId, {
      workspace: { ref: "main" },
    });
    await send(chat.id, "gather");
    // A fork names no ref: it stands on the repository's default branch.
    const fork = await sessions.fork(identity, projectId, chat.id);
    const told = await send(fork.id, "in the fork");
    expect(told).not.toContain("did not run");
    expect(
      (
        await db
          .selectFrom("agent_sessions")
          .select("workspace")
          .where("id", "=", fork.id)
          .executeTakeFirstOrThrow()
      ).workspace,
    ).toMatchObject({ ref: "main" });
    expect((await ranLines()).slice(5)).toEqual([
      "checkout open",
      "checkout ended",
      "widen registry.npmjs.org",
      "setup v3: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=main",
      "narrow",
    ]);
  }, 60_000);

  it("finishes replacing a sandbox when a preparation stopped between destroying it and forgetting it", async () => {
    await fs.rm(runs, { force: true });
    const chat = await sessions.create(identity, projectId, {
      workspace: { ref: "main" },
    });
    await send(chat.id, "gather");
    const first = await sandboxOf(chat.id);
    // What a preparation that stopped midway leaves: the sandbox marked
    // and destroyed, the session still pointing at it.
    const { sandbox_id } = await db
      .selectFrom("agent_sessions")
      .select("sandbox_id")
      .where("id", "=", chat.id)
      .executeTakeFirstOrThrow();
    await db
      .updateTable("project_sandboxes")
      .set({ status: "replacing" })
      .where("id", "=", sandbox_id ?? "")
      .execute();
    await machine.destroySandbox(first);
    await send(chat.id, "after the stop");
    expect(await sandboxOf(chat.id)).not.toBe(first);
    expect((await ranLines()).slice(5)).toEqual([
      "checkout open",
      "checkout ended",
      "widen registry.npmjs.org",
      "setup v3: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=main",
      "narrow",
    ]);
    expect(found.at(-1)).toBe("prod-rows logs");
  }, 60_000);

  it("tells a shared subagent how its workspace's setup on its own network went (ADR 0322)", async () => {
    await fs.rm(runs, { force: true });
    const flag = path.join(tmpDir, "fail-shared");
    await fs.writeFile(flag, "");
    await writeManifest(probe("v4", flag));
    try {
      const chat = await sessions.create(identity, projectId, {
        workspace: { ref: "main" },
      });
      expect(await send(chat.id, "set up")).toContain(
        "failed with exit code 3",
      );
      // It may not rebuild the workspace to set it up again: the chat's next
      // turn does. It is told how the last setup went.
      const child = await sessions.createSubsession(
        identity,
        projectId,
        chat.id,
        { task: "Look at the logs" },
      );
      await vi.waitFor(
        () =>
          expect(
            adapter.attempts.find(
              (attempt) => attempt.sessionId === child.session.id,
            )?.input?.text,
          ).toContain("failed with exit code 3"),
        { timeout: 30_000 },
      );
    } finally {
      await fs.rm(flag, { force: true });
    }
  }, 60_000);

  /*
   * Where a project workflow listens for the setup (ADR 0355). Everything
   * of Work's is real here: who listens, the waited event, the setup, the
   * sandbox and the commands a run starts in it. Only the dispatcher and
   * the workflow runtime are played by hand: each waited event starts one
   * stamped run of `prepareReview`, whose body is `workflow` below.
   */
  describe("where a project workflow listens for the setup (ADR 0355)", () => {
    const automation: Identity = {
      tenantId: identity.tenantId,
      externalUserId: PROJECT_PRINCIPAL_ID,
      scope: [],
    };
    /** A setup event's payload, as the workflow reads it. */
    const SetupPayload = z.object({
      sessionId: z.string(),
      detail: z.object({
        reason: z.string(),
        environment: z.string(),
        workspace: z.object({ ref: z.string(), commit: z.string() }),
        previous: z.object({ commit: z.string() }).nullable(),
        sandbox: z.enum(["new", "kept"]),
      }),
    });
    type Detail = z.infer<typeof SetupPayload>["detail"];
    const ExecResult = z.object({
      exitCode: z.number().nullable(),
      stdout: z.string(),
    });
    interface Tools {
      sessionId: string;
      detail: Detail;
      exec: (args: {
        in: "session" | "setup";
        command: string;
      }) => Promise<{ exitCode: number | null; stdout: string }>;
      /** The paths that differ between two commits of the chat. */
      changed: (from: string, to: string) => Promise<string[] | "unknown">;
    }
    type Workflow = (tools: Tools) => Promise<void>;

    /**
     * A reviewer's setup workflow: install only when a lockfile changed
     * since this sandbox last set up, asking for the setup's network first,
     * and copy the trusted procedure last.
     */
    const prepareReview: Workflow = async ({ detail, exec, changed }) => {
      const paths =
        detail.sandbox === "kept" && detail.previous
          ? await changed(detail.previous.commit, detail.workspace.commit)
          : "unknown";
      if (paths === "unknown" || paths.includes("pnpm-lock.yaml")) {
        const installed = await exec({
          in: "setup",
          command: `mkdir -p node_modules && cp pnpm-lock.yaml node_modules/.installed && echo "install $(cat pnpm-lock.yaml): rows=$([ -f notes/rows.json ] && echo yes || echo no) grants=$(ls ../.work-session/grants 2>/dev/null | wc -l | tr -d ' ') token=\${SETUP_TOKEN:-none}" >> '${runs}'`,
        });
        if (installed.exitCode !== 0) throw new Error("the install failed");
      }
      await exec({
        in: "session",
        command: `echo trusted > PROCEDURE.md && echo "procedure copied" >> '${runs}'`,
      });
    };
    let workflow: Workflow = prepareReview;
    /** Milliseconds a setup's runs get, when a test cuts the setup's time. */
    const setupTime: { capMs?: number } = {};
    const heard: Detail[] = [];
    let exec: SessionExecService;
    let dispatching: ReturnType<typeof setInterval> | undefined;
    let listening: { activationId: string; enablementId: string };
    const seed = () => path.join(tmpDir, "seed");

    /** Push a commit to the pull request's branch; its id. */
    const push = async (files: Record<string, string>) => {
      await git(seed(), ["checkout", "-q", "-B", "pr"]);
      for (const [file, content] of Object.entries(files))
        await fs.writeFile(path.join(seed(), file), content);
      await git(seed(), ["add", "."]);
      await git(seed(), ["commit", "-q", "-m", "push"]);
      await git(seed(), [
        "push",
        "-q",
        "-f",
        path.join(tmpDir, "remote.git"),
        "pr",
      ]);
      return git(seed(), ["rev-parse", "HEAD"]);
    };

    /** A keyed review chat at the pull request, as an automation starts it. */
    const reviewChat = async (key: string | null) => {
      const chat = await sessions.create(identity, projectId, {
        workspace: { ref: "pr" },
      });
      if (key)
        await db
          .updateTable("agent_sessions")
          .set({ chat_key: key })
          .where("id", "=", chat.id)
          .execute();
      return chat.id;
    };

    /** Deliver the pull request's new head to the chat, as a push does. */
    const reset = async (sessionId: string, text: string) => {
      const turns = async () =>
        (await sessions.get(identity, projectId, sessionId)).snapshot.turns;
      const before = (await turns()).length;
      await sessions.command(identity, projectId, sessionId, {
        type: "send",
        commandId: crypto.randomUUID(),
        text,
        workspace: { ref: "pr", update: "reset" },
      });
      await vi.waitFor(
        async () => {
          const now = await turns();
          expect(now.length).toBeGreaterThan(before);
          expect(now.at(-1)?.status).toBe("completed");
        },
        { timeout: 45_000, interval: 50 },
      );
      return adapter.lastInput() ?? "";
    };

    /**
     * Wait until no chat of the project has a turn to run: an earlier
     * test's subagent reports to its parent after that test ended, and
     * every sandbox writes to the same log.
     */
    const quiet = () =>
      vi.waitFor(
        async () => {
          const busy = await db
            .selectFrom("agent_turns")
            .innerJoin(
              "agent_sessions",
              "agent_sessions.id",
              "agent_turns.session_id",
            )
            .select("agent_turns.id")
            .where("agent_sessions.project_id", "=", projectId)
            .where("agent_turns.status", "not in", [...SETTLED_TURN_STATUSES])
            .execute();
          expect(busy).toEqual([]);
        },
        { timeout: 45_000, interval: 100 },
      );

    const inSandbox = async (sessionId: string, command: string) =>
      (
        await machine.executeCommand(await sandboxOf(sessionId), command, {
          cwd: "/workspace/project",
        })
      ).result.trim();

    /** One command of a run, followed to its end as a parked step is. */
    const execOf =
      (input: { runId: string; sessionId: string }): Tools["exec"] =>
      async (args) => {
        const signal = new AbortController().signal;
        const output = await exec
          .execute({
            caller: automation,
            projectId,
            runId: input.runId,
            author: {
              kind: "workflow",
              runId: input.runId,
              workflowName: "prepareReview",
            },
            causation: [],
            signal,
            deadlineAt: new Date(Date.now() + 300_000).toISOString(),
            args: {
              sessionId: input.sessionId,
              in: args.in,
              command: args.command,
              idempotencyKey: crypto.randomUUID(),
            },
          })
          .catch(async (error: unknown) => {
            if (!(error instanceof HostCallParkedError)) throw error;
            for (;;) {
              const followed = await exec.follow({
                waitKey: error.waitKey,
                signal,
                sliceMs: 2_000,
              });
              if (followed.status === "done") return followed.output;
              if (followed.status === "failed") throw new Error(followed.error);
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          });
        return ExecResult.parse(output);
      };

    /** The dispatcher and the runtime, by hand: one run per waited event. */
    const dispatch = async () => {
      const due = await db
        .selectFrom("project_events as event")
        .select(["event.id", "event.payload"])
        .where("event.project_id", "=", projectId)
        .where("event.kind", "=", WORKSPACE_SETUP_EVENT)
        .where("event.waited", "=", true)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("project_event_deliveries as receipt")
                .select("receipt.event_id")
                .whereRef("receipt.event_id", "=", "event.id"),
            ),
          ),
        )
        .execute();
      for (const event of due) {
        const payload = SetupPayload.parse(event.payload);
        const run = await db
          .insertInto("workflow_runs")
          .values({
            project_id: projectId,
            workflow_name: "prepareReview",
            workflow_enablement_id: listening.enablementId,
            external_user_id: PROJECT_PRINCIPAL_ID,
            provenance: JSON.stringify({}),
            status: "running",
            event_id: event.id,
            delivery_key: `event:${listening.activationId}:${event.id}`,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await db
          .insertInto("project_event_deliveries")
          .values({
            activation_id: listening.activationId,
            event_id: event.id,
            status: "completed",
            run_ids: JSON.stringify([run.id]),
          })
          .execute();
        heard.push(payload.detail);
        const ended = (status: string, error?: string) =>
          db
            .updateTable("workflow_runs")
            .set({ status, error: error ?? null, completed_at: new Date() })
            .where("id", "=", run.id)
            .where("status", "=", "running")
            .execute();
        void workflow({
          sessionId: payload.sessionId,
          detail: payload.detail,
          exec: execOf({ runId: run.id, sessionId: payload.sessionId }),
          changed: async (from, to) => {
            const copy = await projectManager.openSession({
              tenantId: identity.tenantId,
              projectId,
              sessionId: payload.sessionId,
            });
            try {
              const differ = await changedPaths({
                repoPath: copy.repoPath,
                from,
                to,
              });
              return differ.complete && !differ.truncated
                ? differ.paths
                : "unknown";
            } finally {
              await copy.dispose();
            }
          },
        }).then(
          () => ended("completed"),
          (error: unknown) =>
            ended(
              "failed",
              error instanceof Error ? error.message : String(error),
            ),
        );
      }
    };

    beforeAll(async () => {
      const kind: TriggerKindRuntime = {
        name: WORKSPACE_SETUP_EVENT,
        payloadJsonSchema: { type: "object" },
        configJsonSchema: { type: "object" },
        validatePayload: () => ({ ok: true }),
        validateConfig: () => ({ ok: true }),
      };
      const triggers = new TriggersService(db, {
        kinds: [kind],
        // Listening reads bindings only.
        projectManager: undefined as unknown as ProjectManager,
        runs: undefined as unknown as RunsService,
      });
      exec = new SessionExecService({ db, sessions, projectManager });
      const commitSha = "c".repeat(40);
      const artifact = await db
        .insertInto("deployment_artifacts")
        .values({
          project_id: projectId,
          commit_sha: commitSha,
          artifact_digest: "test",
          plugin_digest: "none",
          runtime_version: "test",
          transform_version: "test",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("trigger_definition_scans")
        .values({ project_id: projectId, commit_sha: commitSha })
        .execute();
      // Bound for the pull request chats alone, by their key.
      const where: Json[] = [
        { payload: { session: { key: { $prefix: "pr-" } } } },
      ];
      const definition = await db
        .insertInto("trigger_definitions")
        .values({
          project_id: projectId,
          commit_sha: commitSha,
          trigger_kind: WORKSPACE_SETUP_EVENT,
          workflow_name: "prepareReview",
          config: JSON.stringify({}),
          where_filters: JSON.stringify(where),
          can_suspend: false,
          input_parameters: JSON.stringify([]),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const enablement = await db
        .insertInto("workflow_enablements")
        .values({
          tenant_id: identity.tenantId,
          project_id: projectId,
          workflow_name: "prepareReview",
          deployment_artifact_id: artifact.id,
          commit_sha: commitSha,
          environment_name: "review",
          owner_kind: "project",
          owner_external_user_id: null,
          owner_identity: {
            tenantId: identity.tenantId,
            externalUserId: "ada",
          },
          consent_digest: "test",
          created_by_external_user_id: "ada",
          status: "active",
          // These chats are a member's: only an automation that may change
          // them is delivered their events.
          permissions: JSON.stringify(["sessions:write"]),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const activation = await db
        .insertInto("workflow_enablement_triggers")
        .values({
          enablement_id: enablement.id,
          trigger_definition_id: definition.id,
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      listening = { activationId: activation.id, enablementId: enablement.id };
      const waited = new WaitedEventsService({
        db,
        triggers,
        cancelRun: async ({ runId }) => {
          await db
            .updateTable("workflow_runs")
            .set({ status: "canceled", completed_at: new Date() })
            .where("id", "=", runId)
            .where("status", "=", "running")
            .execute();
        },
        pollMs: 20,
      });
      sessions.setSetupHooks({
        events: {
          bound: (input) => waited.bound(input),
          listeners: (input) => waited.listeners(input),
          record: (input) => waited.record(input),
          cancel: (input) => waited.cancel(input),
          // The setup's time is minutes; a test of its end caps it.
          settle: (input) => {
            const cap =
              setupTime.capMs === undefined
                ? undefined
                : Date.now() + setupTime.capMs;
            return waited.settle({
              ...input,
              deadlineAt: () => Math.min(cap ?? Infinity, input.deadlineAt()),
            });
          },
        },
        end: (input) => exec.endSetup(input),
      });
      let busy = false;
      dispatching = setInterval(() => {
        if (busy) return;
        busy = true;
        void dispatch()
          .catch(() => {})
          .finally(() => {
            busy = false;
          });
      }, 20);
      await writeManifest(probe("h1"));
      await quiet();
    }, 90_000);

    afterAll(() => {
      clearInterval(dispatching);
    });

    it("sets a new sandbox up as before, then waits for the workflow, whose commands run as setup does (R2)", async () => {
      await quiet();
      await fs.rm(runs, { force: true });
      heard.length = 0;
      workflow = prepareReview;
      const first = await push({
        "README.md": "pr one\n",
        "pnpm-lock.yaml": "lock-1\n",
        ".gitignore": "node_modules/\n",
      });
      const chat = await reviewChat("pr-acme/web-1");
      await send(chat, "review");
      expect(heard).toEqual([
        {
          reason: "created",
          environment: "review",
          workspace: { ref: "pr", commit: first },
          previous: null,
          sandbox: "new",
        },
      ]);
      // The Environment's command on its network, in a sandbox holding the
      // base alone; then the workflow's install, widened for itself, with
      // the one secret the setup names and nothing of the chat's; narrow
      // again before the procedure is copied and before the agent's grants.
      expect(await ranLines()).toEqual([
        "checkout open",
        "checkout ended",
        "widen registry.npmjs.org",
        "setup h1: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=pr one",
        "narrow",
        "widen registry.npmjs.org",
        "install lock-1: rows=no grants=0 token=setup-token-value",
        "narrow",
        "procedure copied",
        "narrow",
      ]);
      expect(await inSandbox(chat, "cat node_modules/.installed")).toBe(
        "lock-1",
      );
      expect(await inSandbox(chat, "cat PROCEDURE.md")).toBe("trusted");
      expect(found.at(-1)).toBe("no rows logs");
      // Nothing is left that would let a later run use the setup's network.
      expect(
        (
          await db
            .selectFrom("agent_sessions")
            .select("setup_run")
            .where("id", "=", chat)
            .executeTakeFirstOrThrow()
        ).setup_run,
      ).toBeNull();
    }, 90_000);

    it("keeps the sandbox when a push changes no lockfile: the checkout moves in place and nothing is replaced, widened or run again (R3)", async () => {
      await quiet();
      await fs.rm(runs, { force: true });
      heard.length = 0;
      workflow = prepareReview;
      const first = await push({
        "README.md": "pr two\n",
        "pnpm-lock.yaml": "lock-2\n",
        ".gitignore": "node_modules/\n",
      });
      const chat = await reviewChat("pr-acme/web-2");
      await send(chat, "review");
      const sandbox = await sandboxOf(chat);
      await fs.rm(runs, { force: true });
      const second = await push({ "README.md": "pr two, pushed again\n" });
      await reset(chat, "the pull request moved");
      expect(heard.at(-1)).toEqual({
        reason: "base-moved",
        environment: "review",
        workspace: { ref: "pr", commit: second },
        previous: { commit: first },
        sandbox: "kept",
      });
      // The same sandbox, at the new head, with what setup installed.
      expect(await sandboxOf(chat)).toBe(sandbox);
      expect(await inSandbox(chat, "cat README.md")).toBe(
        "pr two, pushed again",
      );
      expect(await inSandbox(chat, "git rev-parse HEAD")).toBe(second);
      expect(await inSandbox(chat, "cat node_modules/.installed")).toBe(
        "lock-2",
      );
      // Narrowed as every used sandbox is; the base fetched by Git into the
      // checkout it had; neither the command nor an install; never widened.
      expect(await ranLines()).toEqual([
        "narrow",
        "checkout open",
        "checkout ended",
        "procedure copied",
      ]);
      // Done for the new base: the next turn sets nothing up.
      expect(
        parseSetupRecord(
          await inSandbox(chat, "cat ../.work-session/setup.done"),
        ),
      ).toMatchObject({ base: second });
      const before = heard.length;
      await send(chat, "again");
      expect(heard.length).toBe(before);
      expect(await sandboxOf(chat)).toBe(sandbox);
      // The agent's grants came back after the setup.
      expect(found.at(-1)).toContain("logs");
    }, 120_000);

    it("replaces the sandbox when a run asks for the setup's network: base alone, the command, then the run's install (R3)", async () => {
      await quiet();
      await fs.rm(runs, { force: true });
      heard.length = 0;
      // Network work goes first: what a run did in the kept sandbox before
      // asking is lost with it.
      workflow = async (tools) => {
        if (tools.detail.sandbox === "kept")
          await tools.exec({
            in: "session",
            command: "echo before > ../before-network",
          });
        await prepareReview(tools);
      };
      const first = await push({
        "README.md": "pr three\n",
        "pnpm-lock.yaml": "lock-3\n",
        ".gitignore": "node_modules/\n",
      });
      const chat = await reviewChat("pr-acme/web-3");
      await send(chat, "review");
      const sandbox = await sandboxOf(chat);
      await fs.rm(runs, { force: true });
      const second = await push({ "pnpm-lock.yaml": "lock-3b\n" });
      await reset(chat, "a dependency changed");
      expect(heard.at(-1)).toEqual({
        reason: "base-moved",
        environment: "review",
        workspace: { ref: "pr", commit: second },
        previous: { commit: first },
        sandbox: "kept",
      });
      const replaced = await sandboxOf(chat);
      expect(replaced).not.toBe(sandbox);
      // The kept sandbox is never widened. The new one is made holding the
      // base alone, the command runs in it on the setup's network, then the
      // run's own command; narrow before anything of the session's arrives.
      expect(await ranLines()).toEqual([
        "narrow",
        "checkout open",
        "checkout ended",
        "checkout open",
        "checkout ended",
        "widen registry.npmjs.org",
        "setup h1: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=pr three",
        "narrow",
        "widen registry.npmjs.org",
        "install lock-3b: rows=no grants=0 token=setup-token-value",
        "narrow",
        "procedure copied",
        "narrow",
      ]);
      expect(await inSandbox(chat, "cat node_modules/.installed")).toBe(
        "lock-3b",
      );
      expect(await inSandbox(chat, "git rev-parse HEAD")).toBe(second);
      expect(
        await inSandbox(
          chat,
          "test -e ../before-network && echo kept || echo lost",
        ),
      ).toBe("lost");
      expect(
        parseSetupRecord(
          await inSandbox(chat, "cat ../.work-session/setup.done"),
        ),
      ).toMatchObject({ base: second });
      expect(found.at(-1)).toContain("logs");
      // Set up: the next turn is the agent's alone, in the new sandbox.
      const before = heard.length;
      await send(chat, "again");
      expect(heard.length).toBe(before);
      expect(await sandboxOf(chat)).toBe(replaced);
    }, 120_000);

    it("tells the agent when a run fails, and asks again before the next turn", async () => {
      await quiet();
      await fs.rm(runs, { force: true });
      heard.length = 0;
      workflow = prepareReview;
      await push({
        "README.md": "pr four\n",
        "pnpm-lock.yaml": "lock-4\n",
        ".gitignore": "node_modules/\n",
      });
      const chat = await reviewChat("pr-acme/web-4");
      await send(chat, "review");
      const sandbox = await sandboxOf(chat);
      const moved = await push({ "README.md": "pr four, again\n" });
      workflow = async () => {
        throw new Error("the lockfile could not be read");
      };
      const told = await reset(chat, "the pull request moved");
      expect(told).toContain(
        "failed in the project's setup workflows (bound to the `session.workspace-setup` trigger)",
      );
      expect(told).toContain("prepareReview");
      expect(told).toContain("the lockfile could not be read");
      expect(told).toContain("They run again before the next turn.");
      // Nothing was replaced, and nothing is recorded done for the new base.
      expect(await sandboxOf(chat)).toBe(sandbox);
      expect(
        parseSetupRecord(
          await inSandbox(chat, "cat ../.work-session/setup.done"),
        ),
      ).not.toMatchObject({ base: moved });
      workflow = prepareReview;
      const before = heard.length;
      const again = await send(chat, "try again");
      expect(again).not.toContain("setup workflows");
      expect(heard.length).toBe(before + 1);
      expect(heard.at(-1)).toMatchObject({
        reason: "base-moved",
        sandbox: "kept",
        workspace: { commit: moved },
      });
      expect(await sandboxOf(chat)).toBe(sandbox);
    }, 120_000);

    it("stops waiting at the setup's time, cancels the run, and counts the setup as failed", async () => {
      await quiet();
      await fs.rm(runs, { force: true });
      heard.length = 0;
      workflow = prepareReview;
      await push({
        "README.md": "pr five\n",
        "pnpm-lock.yaml": "lock-5\n",
        ".gitignore": "node_modules/\n",
      });
      const chat = await reviewChat("pr-acme/web-5");
      await send(chat, "review");
      const sandbox = await sandboxOf(chat);
      const moved = await push({ "README.md": "pr five, again\n" });
      // A run that does not end, and a setup whose time is nearly up.
      let release = () => {};
      workflow = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      setupTime.capMs = 1_500;
      try {
        const told = await reset(chat, "the pull request moved");
        expect(told).toContain(
          "did not finish within 30 minutes: the project's setup workflows (bound to the `session.workspace-setup` trigger) were stopped",
        );
        expect(told).toContain("prepareReview");
        expect(told).toContain("They run again before the next turn.");
      } finally {
        setupTime.capMs = undefined;
        release();
      }
      // Its run was canceled, and nothing of the setup is left on the chat.
      const runsOfChat = await db
        .selectFrom("workflow_runs")
        .innerJoin(
          "project_events",
          "project_events.id",
          "workflow_runs.event_id",
        )
        .select(["workflow_runs.status"])
        .where(sql<boolean>`project_events.payload->>'sessionId' = ${chat}`)
        .orderBy("workflow_runs.created_at")
        .execute();
      expect(runsOfChat.map((run) => run.status)).toEqual([
        "completed",
        "canceled",
      ]);
      expect(
        (
          await db
            .selectFrom("agent_sessions")
            .select("setup_run")
            .where("id", "=", chat)
            .executeTakeFirstOrThrow()
        ).setup_run,
      ).toBeNull();
      // Asked again before the next turn, in the sandbox it kept.
      workflow = prepareReview;
      const before = heard.length;
      expect(await send(chat, "try again")).not.toContain("setup workflows");
      expect(heard.length).toBe(before + 1);
      expect(heard.at(-1)).toMatchObject({
        sandbox: "kept",
        workspace: { commit: moved },
      });
      expect(await sandboxOf(chat)).toBe(sandbox);
    }, 120_000);

    it("replaces a used sandbox as before for a chat nobody listens for (R1)", async () => {
      await quiet();
      await fs.rm(runs, { force: true });
      heard.length = 0;
      workflow = prepareReview;
      await push({
        "README.md": "pr six\n",
        "pnpm-lock.yaml": "lock-6\n",
        ".gitignore": "node_modules/\n",
      });
      // Not a pull request chat by its key: the binding's `where` leaves it out.
      const chat = await reviewChat(null);
      await send(chat, "review");
      const sandbox = await sandboxOf(chat);
      await fs.rm(runs, { force: true });
      await push({ "README.md": "pr six, again\n" });
      await reset(chat, "the pull request moved");
      expect(heard).toEqual([]);
      expect(await sandboxOf(chat)).not.toBe(sandbox);
      expect(await ranLines()).toEqual([
        "narrow",
        "checkout open",
        "checkout ended",
        "widen registry.npmjs.org",
        "setup h1: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=pr six, again",
        "narrow",
      ]);
    }, 120_000);
  });
});
