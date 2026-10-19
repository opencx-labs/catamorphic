import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import {
  type EnvironmentRuntimeBinding,
  SANDBOX_CAPABILITIES,
  type SandboxEgress,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ConnectionAdmissionService } from "../services/connection-admission.js";
import { ConnectionCapabilityGrantsService } from "../services/connection-capability-grants.js";
import type { ResolvedConnectionBinding } from "../services/connection-types.js";
import type { ConnectionsService } from "../services/connections-service.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { SecretsService } from "../services/secrets-service.js";
import { SessionWorkspaces } from "../services/session-workspaces.js";
import { RecordingAdapter } from "./recording-adapter.js";

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

    machine = new LocalProcessSandboxProvider({
      root: path.join(tmpDir, "machine"),
      acceptUnenforcedEgress: true,
    });
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
      sandboxGateway: {
        url: () => "http://work.acme.test/gateway",
        remoteBaseUrls: () => undefined,
        modelApi: () => undefined,
        servesHttp: () => true,
      },
      secrets,
    });
  }, 60_000);

  afterAll(async () => {
    await sessions?.stopLocalTurns();
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("widens a new sandbox holding its base alone, then the agent gets its work back", async () => {
    const chat = await sessions.create(identity, projectId, {
      workspace: { ref: "main" },
    });
    await send(chat.id, "review");
    // Widened to the setup's hosts alone (not the gateway), with nothing
    // but the base checkout and the one secret it names.
    expect(await ranLines()).toEqual([
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
    expect((await ranLines()).slice(3)).toEqual(["narrow"]);
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
    expect((await ranLines()).slice(3)).toEqual([
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
    expect((await ranLines()).slice(3)).toEqual([
      "narrow",
      "widen registry.npmjs.org",
      "setup v2: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=main",
      "narrow",
      "narrow",
      "widen registry.npmjs.org",
      "setup v2: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=main",
      "narrow",
    ]);
    expect(found.at(-1)).toBe("prod-rows logs");
  }, 60_000);

  it("never widens a fork, whose workspace does not start from the remote", async () => {
    await fs.rm(runs, { force: true });
    await writeManifest(probe("v3"));
    const chat = await sessions.create(identity, projectId, {
      workspace: { ref: "main" },
    });
    await send(chat.id, "gather");
    const fork = await sessions.fork(identity, projectId, chat.id);
    const told = await send(fork.id, "in the fork");
    expect(told).toContain(
      "does not start from a commit of the project's remote",
    );
    expect((await ranLines()).slice(3)).toEqual([]);
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
    expect((await ranLines()).slice(3)).toEqual([
      "widen registry.npmjs.org",
      "setup v3: rows=no grants=0 env=0 http=0 token=setup-token-value other=none base=main",
      "narrow",
    ]);
    expect(found.at(-1)).toBe("prod-rows logs");
  }, 60_000);
});
