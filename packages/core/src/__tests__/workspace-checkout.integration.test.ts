import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import {
  ProjectEnvironmentsService,
  parseProjectEnvironmentPolicy,
} from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { SessionWorkspaces } from "../services/session-workspaces.js";
import {
  checkoutTarget,
  WorkspaceCheckoutsService,
} from "../services/workspace-checkouts.js";
import { RecordingAdapter } from "./recording-adapter.js";
import { startCheckoutGateway } from "./test-checkout-gateway.js";

const ownedSandboxes = new TestSandboxes();

/**
 * A workspace's base arrives by Git (ADR 0353), end to end with real
 * sandboxes and a gateway they really fetch from: Work serves the commit a
 * chat stands on from the chat's own copy, the Environment's checkout
 * command decides how much of it arrives, and the token that let it be
 * fetched has ended before the agent's first command. The project here has
 * no repository of its own: its base is Work's own main.
 */

const execFileAsync = promisify(execFile);
const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_workspace_checkout";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "ada",
};
const AGENT_GIT = "git -c user.name=Agent -c user.email=agent@example.test";

/** One cone of a monorepo, and none of the files outside it. */
const SPARSE = [
  "git sparse-checkout set --cone apps/web .work",
  'git fetch --quiet --no-tags --depth=1 --filter=blob:none work "$WORK_BASE"',
  "git checkout --quiet --detach FETCH_HEAD",
].join("\n");

describe("a workspace's base arrives by Git (ADR 0353)", () => {
  let tmpDir: string;
  let projectId: string;
  let projectManager: ProjectManager;
  let sessions: AgentSessionsService;
  let uploading: AgentSessionsService;
  let unreachable: AgentSessionsService;
  let checkouts: WorkspaceCheckoutsService;
  let machine: LocalProcessSandboxProvider;
  let gateway: Awaited<ReturnType<typeof startCheckoutGateway>>;
  const allocations = new ExecutionAllocationsService(db);
  /** What the agent does in its checkout this turn, and what it printed. */
  let script = "true";
  let printed = "";
  const adapter = new RecordingAdapter({
    before: async (attempt) => {
      const result = await machine.executeCommand(
        await sandboxOf(attempt.sessionId),
        script,
        { cwd: "/workspace/project" },
      );
      printed = result.result.trim();
      if (result.exitCode !== 0)
        throw new Error(`The agent's commands failed: ${printed}`);
    },
  });

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

  /** One turn: the agent runs `commands` in its checkout. */
  const turn = async (input: {
    sessionId: string;
    commands: string;
    service?: AgentSessionsService;
  }) => {
    script = input.commands;
    printed = "";
    const result = await (input.service ?? sessions).sendMessage(
      identity,
      projectId,
      input.sessionId,
      "work",
    );
    return { status: result.turn.status, lines: printed.split("\n") };
  };

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

  let published = 0;
  /** Publish files to the project's own main. */
  const publish = (files: Record<string, string>) =>
    projectManager.publishFiles({
      tenantId: identity.tenantId,
      projectId,
      files,
      message: "Published",
      author: { name: "Test", email: "test@example.com" },
    });

  /** The project's Environment, with this way of checking out or Work's. */
  const environment = async (checkout?: {
    command: string;
    timeoutMinutes?: number;
  }) => {
    await publish({
      [PROJECT_MANIFEST_PATH]: JSON.stringify({
        environments: {
          work: { workloads: ["agent"], ...(checkout ? { checkout } : {}) },
        },
        defaultEnvironment: "work",
        // Every Environment is a commit of its own, so each test's chats
        // stand on a base no earlier chat fetched.
        description: `Environment ${++published}`,
      }),
    });
    return projectManager.mainCommit({
      tenantId: identity.tenantId,
      projectId,
    });
  };

  const checkoutsOf = (sessionId: string) =>
    db
      .selectFrom("workspace_checkouts")
      .select(["id", "commit_sha", "revoked_at"])
      .where("session_id", "=", sessionId)
      .orderBy("created_at")
      .execute();

  /** Why the chat's last turn failed, as its person reads it. */
  const failure = async (sessionId: string) => {
    const row = await db
      .selectFrom("agent_turns")
      .select("error")
      .where("session_id", "=", sessionId)
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    return JSON.stringify(row.error);
  };

  /** Fetch `commit` from a checkout as a sandbox would, into a new repository. */
  const fetch = async (input: {
    id: string;
    token: string;
    commit: string;
  }) => {
    const into = await fs.mkdtemp(path.join(tmpDir, "fetch-"));
    await execFileAsync("git", ["-C", into, "init", "-q"]);
    const url = `${gateway.url}/checkout/${input.id}`;
    const ran = await execFileAsync(
      "git",
      [
        "-C",
        into,
        "-c",
        `http.${url}.extraHeader=Authorization: Bearer ${input.token}`,
        "fetch",
        "--depth=1",
        url,
        input.commit,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    ).then(
      () => ({ ok: true, text: "" }),
      (error: { stderr?: string }) => ({ ok: false, text: error.stderr ?? "" }),
    );
    return { ...ran, into };
  };

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-checkout-"));
    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
      new FsRemoteBackend(path.join(tmpDir, "origins")),
    );
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    projectId = (await projects.create(identity, { name: "Monorepo" })).id;
    await publish({
      "README.md": "monorepo\n",
      "apps/web/page.txt": "web\n",
      "apps/api/server.txt": "api\n",
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
    checkouts = new WorkspaceCheckoutsService(db, { projectManager });
    gateway = await startCheckoutGateway(() => checkouts);
    const service = (gatewayUrl: string | undefined) =>
      new AgentSessionsService(db, {
        hostId: "workspace-checkout-host",
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
    // A host that serves no gateway: its sandboxes cannot fetch.
    uploading = service(undefined);
    // A host that names a gateway its sandboxes do not reach.
    unreachable = service("http://127.0.0.1:1/gateway");
  }, 60_000);

  afterAll(async () => {
    await cleanupTestResources(
      [
        () => sessions?.stopLocalTurns(),
        () => uploading?.stopLocalTurns(),
        () => unreachable?.stopLocalTurns(),
        () => ownedSandboxes.cleanup(),
        () => gateway?.close(),
        () => db.destroy(),
      ],
      () => fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 }),
    );
  });

  it("serves one commit to the holder of a live token, and nobody else", async () => {
    const earlier = await projectManager.mainCommit({
      tenantId: identity.tenantId,
      projectId,
    });
    const main = await environment();
    // A chat that worked once: its copy holds the commit it stands on.
    const chat = await sessions.create(identity, projectId, {});
    expect((await turn({ sessionId: chat.id, commands: "true" })).status).toBe(
      "completed",
    );
    const of = {
      tenantId: identity.tenantId,
      projectId,
      sessionId: chat.id,
      commit: main,
    };
    const issued = await checkouts.issue(of);
    const fetched = await fetch({ ...issued, commit: main });
    expect(fetched).toMatchObject({ ok: true });
    // The commit and its files, and no history before it.
    expect(
      (
        await execFileAsync("git", [
          "-C",
          fetched.into,
          "log",
          "--format=%H",
          "FETCH_HEAD",
        ])
      ).stdout.trim(),
    ).toBe(main);
    expect(
      (
        await execFileAsync("git", [
          "-C",
          fetched.into,
          "show",
          "FETCH_HEAD:apps/api/server.txt",
        ])
      ).stdout,
    ).toBe("api\n");
    // Nothing else the repository holds, whatever id is named.
    const parent = await fetch({ ...issued, commit: earlier });
    expect(parent.ok).toBe(false);
    expect(parent.text).toMatch(/not our ref|unadvertised/);

    // Git shows the person why, which a 401 would not.
    const ENDED = "remote: This checkout has ended.";
    const wrong = await fetch({
      ...issued,
      token: "not-the-token",
      commit: main,
    });
    expect(wrong).toMatchObject({ ok: false });
    expect(wrong.text).toContain(ENDED);
    // Another checkout's token opens only its own.
    const other = await checkouts.issue(of);
    expect(
      (await fetch({ id: issued.id, token: other.token, commit: main })).ok,
    ).toBe(false);
    expect((await fetch({ ...other, commit: main })).ok).toBe(true);
    // Past its time.
    await db
      .updateTable("workspace_checkouts")
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where("id", "=", other.id)
      .execute();
    expect((await fetch({ ...other, commit: main })).text).toContain(ENDED);
    // Ended by its issuer.
    await checkouts.revoke({ id: issued.id });
    expect((await fetch({ ...issued, commit: main })).text).toContain(ENDED);
    // Only the token's hash is kept.
    const stored = await db
      .selectFrom("workspace_checkouts")
      .select("token_hash")
      .where("id", "=", issued.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toContain(issued.token);

    expect(gateway.served.refused).toBeGreaterThanOrEqual(4);
    // No header, a checkout that never was, and a path that is not Git's.
    for (const request of [
      { id: issued.id, authorization: undefined },
      { id: "not-a-checkout", authorization: `Bearer ${other.token}` },
    ])
      expect(
        (
          await checkouts.handle({
            ...request,
            operation: "advertise",
            headers: {},
          })
        ).status,
      ).toBe(403);
    expect(
      checkoutTarget({
        method: "GET",
        path: `${issued.id}/info/refs`,
        service: "git-upload-pack",
      }),
    ).toEqual({ id: issued.id, operation: "advertise" });
    expect(
      checkoutTarget({
        method: "POST",
        path: `${issued.id}/git-upload-pack`,
        service: undefined,
      }),
    ).toEqual({ id: issued.id, operation: "upload-pack" });
    // Nothing is pushed to a checkout, and nothing is served as files.
    for (const refused of [
      { method: "POST", path: `${issued.id}/git-receive-pack` },
      {
        method: "GET",
        path: `${issued.id}/info/refs`,
        service: "git-receive-pack",
      },
      { method: "GET", path: `${issued.id}/HEAD` },
      { method: "GET", path: "" },
    ] as const)
      expect(checkoutTarget({ service: undefined, ...refused })).toBeNull();
  }, 60_000);

  it("fetches a new chat's base from Work, whole, with a token that has ended", async () => {
    const main = await environment();
    const served = { ...gateway.served };
    const chat = await sessions.create(identity, projectId, {});
    const first = await turn({
      sessionId: chat.id,
      commands: [
        "git rev-parse HEAD",
        "git log --format=%s | wc -l | tr -d ' '",
        "cat apps/web/page.txt apps/api/server.txt",
        // Nothing of the checkout stays: no remote, no header in any
        // config, no variable.
        "(git remote | wc -l | tr -d ' ')",
        "(git config --get-regexp 'extraheader' || echo no-header)",
        "(env | grep -c '^GIT_CONFIG' || true)",
      ].join(" && "),
    });
    expect(first.status).toBe("completed");
    expect(first.lines).toEqual([
      main,
      // No history before the base.
      "1",
      "web",
      "api",
      "0",
      "no-header",
      "0",
    ]);
    const [checkout, ...none] = await checkoutsOf(chat.id);
    expect(none).toEqual([]);
    expect(checkout).toMatchObject({ commit_sha: main });
    expect(checkout?.revoked_at).not.toBeNull();
    expect(gateway.served.advertise).toBeGreaterThan(served.advertise);
    expect(gateway.served["upload-pack"]).toBeGreaterThan(
      served["upload-pack"],
    );

    // A later turn in the same sandbox fetches nothing, and can fetch
    // nothing: the agent that learns where its base came from is refused.
    const later = await turn({
      sessionId: chat.id,
      commands: `git fetch --depth=1 ${gateway.url}/checkout/${checkout?.id} ${main} 2>&1 || true`,
    });
    expect(later.lines.join("\n")).toContain(
      "remote: This checkout has ended.",
    );
    expect(await checkoutsOf(chat.id)).toHaveLength(1);
  }, 60_000);

  it("runs the Environment's checkout command: one cone of a monorepo, and the agent's work comes back onto it", async () => {
    const main = await environment({ command: SPARSE });
    const chat = await sessions.create(identity, projectId, {});
    const look = [
      "ls apps",
      "cat apps/web/page.txt",
      // Every file is still the commit's, whether or not it is here.
      "git ls-tree -r --name-only HEAD | grep -c .",
      "(git rev-list --objects --missing=print HEAD | grep -c '^?' || true)",
      "git status --porcelain -uall",
    ].join(" && ");
    const first = await turn({
      sessionId: chat.id,
      commands: `git rev-parse HEAD && ${look}`,
    });
    expect(first.status).toBe("completed");
    expect(first.lines).toEqual([
      main,
      // The cone alone.
      "web",
      "web",
      "5",
      // The file outside the cone was never sent.
      "1",
    ]);
    // What it left out is read through its remote, which stays for that
    // and serves nothing once the checkout has ended: Git says why.
    const outside = await turn({
      sessionId: chat.id,
      commands:
        "git remote && (git cat-file -p HEAD:apps/api/server.txt 2>&1 || true)",
    });
    expect(outside.lines[0]).toBe("work");
    expect(outside.lines.join("\n")).toContain(
      "remote: This checkout has ended.",
    );

    // The agent commits in the cone and leaves a file uncommitted.
    const worked = await turn({
      sessionId: chat.id,
      commands: [
        "echo changed > apps/web/page.txt",
        `${AGENT_GIT} commit -q -am 'Change the page'`,
        "echo draft > apps/web/notes.txt",
      ].join(" && "),
    });
    expect(worked.status).toBe("completed");

    // Its workspace is given back; the next one is checked out the same
    // way, and what the chat added arrives on top without the base.
    await release(chat.id);
    const again = await turn({
      sessionId: chat.id,
      commands: `git log --format=%s -1 && ${look} && cat apps/web/notes.txt && git diff --stat HEAD~1 HEAD | tail -1`,
    });
    expect(again.status).toBe("completed");
    expect(again.lines.slice(0, 7)).toEqual([
      "Change the page",
      "web",
      "changed",
      "5",
      "1",
      "?? apps/web/notes.txt",
      "draft",
    ]);
    expect(again.lines.at(-1)).toContain("1 file changed");
    const fetched = await checkoutsOf(chat.id);
    expect(fetched).toHaveLength(2);
    expect(fetched.every((row) => row.revoked_at !== null)).toBe(true);
    expect(fetched.map((row) => row.commit_sha)).toEqual([main, main]);
  }, 90_000);

  it("fails the turn with what the command printed when it fails, and ends its token", async () => {
    await environment({
      command: 'echo "no mirror holds $WORK_BASE" >&2\nexit 7',
    });
    const chat = await sessions.create(identity, projectId, {});
    const failed = await turn({ sessionId: chat.id, commands: "true" });
    expect(failed.status).toBe("failed");
    const why = await failure(chat.id);
    expect(why).toContain("check out the workspace's base");
    expect(why).toMatch(/no mirror holds [0-9a-f]{40}/);
    const [checkout] = await checkoutsOf(chat.id);
    expect(checkout?.revoked_at).not.toBeNull();
  }, 60_000);

  it("refuses a checkout that ends anywhere but on the base", async () => {
    // Fetched, and never checked out.
    await environment({
      command: 'git fetch --quiet --depth=1 work "$WORK_BASE"',
    });
    const chat = await sessions.create(identity, projectId, {});
    const failed = await turn({ sessionId: chat.id, commands: "true" });
    expect(failed.status).toBe("failed");
    const why = await failure(chat.id);
    expect(why).toContain(
      "The checkout command ended without the workspace's base checked out: HEAD is unset",
    );
    // A command that prints its token does not put it in the chat.
    await environment({
      command: 'echo "token: $GIT_CONFIG_VALUE_0" >&2\nexit 1',
    });
    const leaky = await sessions.create(identity, projectId, {});
    await turn({ sessionId: leaky.id, commands: "true" });
    const told = await failure(leaky.id);
    expect(told).toContain("token: Authorization: Bearer ***");
  }, 60_000);

  it("uploads the base where sandboxes cannot fetch, and refuses a checkout command there", async () => {
    const main = await environment();
    const chat = await uploading.create(identity, projectId, {});
    const first = await turn({
      service: uploading,
      sessionId: chat.id,
      commands:
        "git rev-parse HEAD && cat apps/api/server.txt && (git remote | wc -l | tr -d ' ')",
    });
    expect(first.status).toBe("completed");
    expect(first.lines).toEqual([main, "api", "0"]);
    expect(await checkoutsOf(chat.id)).toEqual([]);

    await environment({ command: SPARSE });
    const sparse = await uploading.create(identity, projectId, {});
    const refused = await turn({
      service: uploading,
      sessionId: sparse.id,
      commands: "true",
    });
    expect(refused.status).toBe("failed");
    expect(await failure(sparse.id)).toContain("checkout command");
  }, 60_000);

  it("uploads the base when Work's own fetch cannot reach the gateway, and leaves a named command's failure to it", async () => {
    const main = await environment();
    const chat = await unreachable.create(identity, projectId, {});
    const first = await turn({
      service: unreachable,
      sessionId: chat.id,
      commands:
        "git rev-parse HEAD && cat apps/api/server.txt && (git remote | wc -l | tr -d ' ') && git status --porcelain -uall",
    });
    expect(first.status).toBe("completed");
    // The base whole, and nothing left of the fetch that failed.
    expect(first.lines).toEqual([main, "api", "0"]);
    const [tried] = await checkoutsOf(chat.id);
    expect(tried?.revoked_at).not.toBeNull();

    await environment({ command: SPARSE });
    const sparse = await unreachable.create(identity, projectId, {});
    const failed = await turn({
      service: unreachable,
      sessionId: sparse.id,
      commands: "true",
    });
    expect(failed.status).toBe("failed");
    expect(await failure(sparse.id)).toContain(
      "check out the workspace's base",
    );
  }, 60_000);

  it("reads `checkout` as part of an Environment, and nothing it does not know", () => {
    const entry = (checkout: unknown) =>
      parseProjectEnvironmentPolicy({
        environments: { work: { workloads: ["agent"], checkout } },
      }).entries[0];
    expect(
      entry({ command: SPARSE, timeoutMinutes: 45 })?.definition?.checkout,
    ).toEqual({ command: SPARSE, timeoutMinutes: 45 });
    for (const invalid of [
      {},
      { command: "" },
      { command: "true", timeoutMinutes: 0 },
      { command: "true", timeoutMinutes: 241 },
      { command: "true", workflow: "checkOut" },
    ])
      expect(entry(invalid)?.invalid?.error).toMatch(/^checkout/);
  });
});
