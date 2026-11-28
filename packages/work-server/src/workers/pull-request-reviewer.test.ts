import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type Identity, projectChatIdentity } from "@catamorphic/core";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { gitHttpServer, replyOf, testServerOptions } from "../test-support.js";
import { startWorkWorker } from "./worker-runtime.js";

const execute = promisify(execFile);
async function nativeGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  return (await execute("git", ["-C", cwd, ...args])).stdout;
}

/**
 * A pull request reviewer on Work, end to end (ADR 0355): a repository
 * served over HTTP like a code host, one keyed chat per pull request at
 * `refs/pull/<n>/head` on a worker of its own, a `review` Environment whose
 * setup has a network and a command, and a project workflow bound to
 * `session.workspace-setup` that installs only when a lockfile changed.
 *
 * Everything is real but the agent, which runs the commands it is sent: the
 * Work server and its dispatcher, the workflow runtime, the worker, its
 * sandboxes and Git. What it proves is what a push costs: a push that
 * changes no lockfile keeps the sandbox, its checkout and what setup
 * installed; one that changes the lockfile gets a new sandbox, the
 * Environment's command and the workflow's install; and a workspace given
 * back while idle is set up again.
 *
 * Then the rest of a panel reviewer's path: the chat's agent starts
 * subagents that share its workspace, each submits a typed finding stamped
 * with the commit the workspace stands on, and a second project workflow
 * hears each finding as it is recorded and reads the whole panel's.
 */
const UPSTREAM_USER = "robot";
const UPSTREAM_SECRET = `upstream-secret-${randomUUID()}`;
const identity: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "work-setup-agent",
};
const author = [
  "-c",
  "user.name=Upstream",
  "-c",
  "user.email=upstream@example.test",
];
const PULL = "refs/pull/7/head";

let root: string;
let server: WorkServer;
let base: string;
let projectId: string;
let upstream: http.Server;
let repository: string;
let work: string;
/** One line per run of the Environment's command and of the install. */
let setupLog: string;
/** One line per finding the posting workflow heard. */
let findingsLog: string;
const workers: Array<Awaited<ReturnType<typeof startWorkWorker>>> = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Push a commit to the pull request; its id. */
async function push(files: Record<string, string>, message: string) {
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(work, name), content);
  await nativeGit(work, ["add", "-A"]);
  await nativeGit(work, [...author, "commit", "-q", "-m", message]);
  await nativeGit(work, ["push", "-q", repository, `HEAD:${PULL}`]);
  return (await nativeGit(work, ["rev-parse", "HEAD"])).trim();
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * The project's setup workflow, as a reviewer writes it: bound to the
 * setup event of its pull request chats, it compares the lockfiles of the
 * base this sandbox last set up on with the one it stands on now, installs
 * (as setup does, on the setup's network) only when one changed, and copies
 * the trusted review procedure from the published program last.
 */
const workflows = (
  log: string,
  findings: string,
) => `import { appendFile } from "node:fs/promises";
import {
  type BoundaryContext,
  type Carried,
  defineWorkflow,
  type SessionChangedPaths,
  type SessionExecResult,
  type SessionState,
  trigger,
} from "@catamorphic/workflow";

type SetupEvent = {
  id: string;
  payload: {
    sessionId: string;
    detail: {
      reason: "created" | "rebuilt" | "base-moved" | "changed";
      environment: string;
      workspace: { ref: string; commit: string };
      previous: { commit: string } | null;
      sandbox: "new" | "kept";
    };
  };
};

/** What a setup carries from step to step. */
type Setup = { event: string; sessionId: string; install: boolean };

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "bun.lock"];

/** @displayname Prepare review */
export const prepareReview = defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("session.workspace-setup", {
      where: { payload: { session: { key: { $prefix: "pr-" } } } },
    }),
  ],
  steps: [
    /** @displayname See what the push changed */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<SetupEvent>) => {
        const { previous, workspace, sandbox } = input.payload.detail;
        const setup: Setup = {
          event: input.id,
          sessionId: input.payload.sessionId,
          install: true,
        };
        // A new sandbox, or one that never set up: nothing to compare.
        if (sandbox === "new" || !previous) return { result: null, state: setup };
        return host["catamorphic.sessions"].changedPaths(
          { sessionId: setup.sessionId, from: previous.commit, to: workspace.commit },
          { state: setup },
        );
      },
    }),
    /** @displayname Install when a lockfile changed */
    defineBoundary({
      run: ({
        input,
        host,
      }: BoundaryContext<Carried<SessionChangedPaths | null, Setup>>) => {
        const changed = input.result;
        // Unknown, or too much to list: everything may have changed.
        const install =
          !changed ||
          !changed.complete ||
          changed.truncated ||
          changed.paths.some((path) =>
            LOCKFILES.includes(path.split("/").at(-1) ?? ""),
          );
        const setup: Setup = { ...input.state, install };
        if (!install) return { result: null, state: setup };
        // On the setup's network, so first: in a kept sandbox Work makes a
        // new one for it, and what ran before would be lost with the old.
        return host["catamorphic.sessions"].exec(
          {
            sessionId: setup.sessionId,
            in: "setup",
            command: ${JSON.stringify(
              `mkdir -p node_modules && cp pnpm-lock.yaml node_modules/.installed && echo "install $(cat pnpm-lock.yaml)" >> '${log}'`,
            )},
            idempotencyKey: "install:" + setup.event,
          },
          { state: setup },
        );
      },
    }),
    /** @displayname Copy the trusted procedure */
    defineBoundary({
      run: ({
        input,
        host,
      }: BoundaryContext<Carried<SessionExecResult | null, Setup>>) => {
        if (input.result && input.result.exitCode !== 0)
          throw new Error("The install failed: " + input.result.stderr.slice(-500));
        // In the session: it needs no network, so it never asks for a new
        // sandbox. From the program this run executes, never the change.
        // The program's copy is read-only, and so is what an earlier setup
        // copied into a sandbox that was kept: cp -f replaces it.
        return host["catamorphic.sessions"].exec(
          {
            sessionId: input.state.sessionId,
            in: "session",
            command:
              'mkdir -p .review && cp -f "$WORK_PROGRAM/skills/review/SKILL.md" .review/PROCEDURE.md',
            idempotencyKey: "procedure:" + input.state.event,
          },
          { state: input.state },
        );
      },
    }),
    /** @displayname Report */
    defineBoundary({
      run: async ({
        input,
      }: BoundaryContext<Carried<SessionExecResult, Setup>>) => {
        if (input.result.exitCode !== 0)
          throw new Error("The procedure was not copied: " + input.result.stderr.slice(-500));
        return { installed: input.state.install };
      },
    }),
  ],
}));

type ResultEvent = {
  payload: {
    sessionId: string;
    session: { parentSessionId: string | null };
    detail: { name: string; value: { title: string }; commit: string | null };
  };
};

/** One finding, as the posting workflow carries it. */
type Finding = { title: string; commit: string | null; reviewer: string };

/**
 * @displayname Post finding
 * @param line - @displayname Line | @description The finding as it is posted
 */
async function postFinding({ line }: { line: string }) {
  "use step";
  await appendFile(${JSON.stringify(findings)}, line + "\\n");
}

/** @displayname Post findings */
export const postFindings = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("session.result-recorded", { names: ["finding"] })],
  steps: [
    /** @displayname Read the panel's findings */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<ResultEvent>) => {
        const finding: Finding = {
          title: input.payload.detail.value.title,
          commit: input.payload.detail.commit,
          reviewer: input.payload.sessionId,
        };
        // The review's own chat, and every subagent's results with it.
        return host["catamorphic.sessions"].read(
          {
            sessionId: input.payload.session.parentSessionId ?? input.payload.sessionId,
            include: ["results"],
            name: "finding",
            family: true,
          },
          { state: finding },
        );
      },
    }),
    /** @displayname Post it */
    defineBoundary({
      run: async ({
        input,
      }: BoundaryContext<Carried<SessionState, Finding>>) => {
        await postFinding({
          line: JSON.stringify({
            ...input.state,
            panel: input.result.results.map((result) => result.sessionId),
          }),
        });
        return { posted: input.state.title };
      },
    }),
  ],
}));
`;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-reviewer-"));
  setupLog = path.join(root, "setup.log");
  findingsLog = path.join(root, "findings.log");
  // The upstream: `main` and a pull request head, like a code host. What
  // an install writes is ignored by Git, as `node_modules` is.
  const projects = path.join(root, "upstream");
  repository = path.join(projects, "repo.git");
  fs.mkdirSync(repository, { recursive: true });
  await nativeGit(repository, ["init", "--bare", "-q", "-b", "main"]);
  work = path.join(root, "upstream-work");
  fs.mkdirSync(work);
  await nativeGit(work, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(work, "readme.md"), "hello\n");
  fs.writeFileSync(path.join(work, ".gitignore"), "node_modules/\n.review/\n");
  fs.writeFileSync(path.join(work, "pnpm-lock.yaml"), "lock-1\n");
  await nativeGit(work, ["add", "-A"]);
  await nativeGit(work, [...author, "commit", "-q", "-m", "Initial"]);
  await nativeGit(work, ["push", "-q", repository, "main"]);
  await nativeGit(work, ["checkout", "-q", "-b", "feature"]);
  upstream = gitHttpServer({
    projectRoot: projects,
    user: UPSTREAM_USER,
    secret: UPSTREAM_SECRET,
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string")
    throw new Error("No upstream address");
  const upstreamBase = `http://127.0.0.1:${upstreamAddress.port}/`;

  const gatewayFile = path.join(root, "gateway.json");
  fs.writeFileSync(
    gatewayFile,
    JSON.stringify({
      connections: [
        {
          type: "git",
          kind: "upstream-git",
          displayName: "Upstream Git",
          baseUrl: upstreamBase,
        },
      ],
    }),
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = await createWorkServer(
    testServerOptions({
      dataDir: path.join(root, "control-plane"),
      publicBases: [base],
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        WORK_GATEWAY_CONFIG: gatewayFile,
        PATH: process.env.PATH,
      },
    }),
  );
  await server.app.listen({ port, host: "127.0.0.1" });
  const operatorSecret = fs
    .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
    .trim();
  const core = server.catamorphic.core;
  const project = await core.projects.create(identity, { name: "Reviews" });
  projectId = project.id;
  await core.db
    .updateTable("projects")
    .set({
      remote_url: `${upstreamBase}repo.git`,
      remote_branch: "main",
      default_branch: "main",
      remote_ownership: "attached",
    })
    .where("id", "=", projectId)
    .execute();
  const deployed = await core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    identity.externalUserId,
    {
      message: "Review pull requests",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            automation: {
              pool: { plane: "control" },
              workloads: ["workflow"],
            },
            review: {
              pool: { pool: "review" },
              workloads: ["agent"],
              idleReleaseMinutes: 5,
              network: { egress: "gateway" },
              // A setup with a network of its own (ADR 0257): only a
              // sandbox holding its base alone is ever given it.
              setup: {
                command: `echo "command $WORK_SETUP_REASON $(cat pnpm-lock.yaml)" >> '${setupLog}'`,
                timeoutMinutes: 5,
                network: { allow: ["registry.npmjs.org"] },
              },
              connections: {
                code: {
                  provider: "upstream-git",
                  principal: "service",
                  service: "upstream",
                  git: { push: ["work/*"] },
                },
              },
            },
          },
          defaultEnvironment: "review",
        }),
        ".work/agents/reviewer.json": JSON.stringify({
          version: 1,
          name: "Reviewer",
          kind: "builtin",
          environment: { allowed: ["review"], preferred: ["review"] },
          connections: ["code"],
          // What a reviewer hands in while it works (ADR 0323).
          results: {
            finding: {
              type: "object",
              additionalProperties: false,
              required: ["title"],
              properties: { title: { type: "string", minLength: 1 } },
            },
          },
        }),
        ".work/skills/review/SKILL.md": "# Review\n\nThe trusted procedure.\n",
        ".work/package.json": JSON.stringify({
          name: "reviews-work",
          private: true,
          workspaces: ["workflows"],
        }),
        ".work/workflows/package.json": JSON.stringify({
          name: "@reviews/workflows",
          private: true,
          type: "module",
          dependencies: { "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION },
        }),
        ".work/workflows/src/reviews.ts": workflows(setupLog, findingsLog),
      },
    },
  );
  expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
  // The workflows are the project's own automations: turned on once, with
  // what they declare, they hear every pull request chat's setup and every
  // finding its reviewers record.
  for (const workflowName of ["prepareReview", "postFindings"]) {
    const request = {
      identity,
      projectId,
      workflowName,
      owner: { type: "project" as const },
      environment: "automation",
    };
    const preview = await core.workflowEnablements.preview(request);
    await core.workflowEnablements.create({
      ...request,
      consentDigest: preview.consentDigest,
    });
  }
  // The upstream password lives only in the control plane's vault.
  const connections = core.connections;
  if (!connections) throw new Error("Connections are unavailable");
  const created = await connections.createService({
    identity,
    name: "upstream",
    providerKind: "upstream-git",
    principalKind: "project_service",
    projectId,
  });
  const started = await connections.beginServiceAuthorization({
    identity,
    connectionId: created.id,
    redirectUri: `${base}/api/connection-authorizations/callback`,
  });
  await connections.completeAuthorization({
    identity,
    state: started.authorizationId,
    callback: { username: UPSTREAM_USER, password: UPSTREAM_SECRET },
  });

  const enrollment = await server.operatorApp.inject({
    method: "POST",
    url: "/_work/operator/workers",
    headers: {
      authorization: `Bearer ${operatorSecret}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify({
      name: "reviewer",
      labels: { pool: "review" },
      trusted: true,
    }),
  });
  expect(enrollment.statusCode).toBe(201);
  workers.push(
    await startWorkWorker({
      controlPlaneUrl: base,
      dataDir: path.join(root, "reviewer"),
      enrollmentCode: enrollment.json().code,
      execution: executionSettingsFromEnv({
        WORK_SANDBOX: "local-process",
        PATH: process.env.PATH,
        WORK_MAX_WORKSPACES: "2",
        // Subprocesses enforce no egress: the switches are still made.
        WORK_UNENFORCED_EGRESS: "accept",
      }),
    }),
  );
  await waitFor(async () => {
    const machines = (
      await server.operatorApp.inject({
        method: "GET",
        url: "/_work/operator/machines",
        headers: { authorization: `Bearer ${operatorSecret}` },
      })
    ).json();
    return machines.machines.some(
      (machine: { id: string; available: boolean }) =>
        machine.id === "worker.reviewer" && machine.available,
    );
  }, "the review worker to connect");
}, 180_000);

afterAll(async () => {
  await Promise.all(workers.map((running) => running.stop()));
  await server?.shutdown();
  upstream?.closeAllConnections();
  await new Promise((resolve) => upstream?.close(resolve));
  if (root) {
    // Deployment snapshots in the workflow sandbox are read-only.
    const writable = (dir: string) => {
      fs.chmodSync(dir, 0o700);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory()) writable(path.join(dir, entry.name));
    };
    writable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

const SetupDetail = z.object({
  reason: z.string(),
  environment: z.string(),
  workspace: z.object({ ref: z.string(), commit: z.string() }),
  previous: z.object({ commit: z.string() }).nullable(),
  sandbox: z.enum(["new", "kept"]),
});
const Phases = z.array(z.object({ phase: z.string() }));

describe("a pull request reviewer on Work, end to end", () => {
  let sessionId = "";
  let runId = "";
  let firstHead = "";
  let secondHead = "";
  let thirdHead = "";
  let firstSandbox = "";
  let secondSandbox = "";

  const sessions = () => {
    const service = server.catamorphic.core.agentSessions;
    if (!service) throw new Error("Agent sessions are unavailable");
    return service;
  };
  const db = () => server.catamorphic.core.db;

  /**
   * What the reviewing automation sends its pull request's chat. It runs
   * as the project, so the chat for a key is the project's own: one per
   * pull request, whoever opened it.
   */
  const deliver = async (input: {
    content: string;
    workspace: { ref: string; update?: "reset" };
  }) => {
    const delivered = await server.catamorphic.core.capabilities.call(
      "catamorphic.sessions",
      "deliver",
      {
        caller: projectChatIdentity({
          tenantId: SERVER_TENANT_ID,
          projectId,
        }),
        projectId,
        runId,
        workflowName: "reviewPullRequests",
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 300_000).toISOString(),
      },
      {
        key: "pr-7",
        agentSlug: "reviewer",
        title: "Review: pull request 7",
        content: input.content,
        idempotencyKey: randomUUID(),
        workspace: input.workspace,
      },
    );
    if (
      !delivered ||
      typeof delivered !== "object" ||
      !("sessionId" in delivered)
    )
      throw new Error("No session");
    return String(delivered.sessionId);
  };
  const answers = async () =>
    (await sessions().transcript(identity, projectId, sessionId))
      .filter((message) => message.role === "assistant")
      .map((message) => message.content);
  const settled = () =>
    waitFor(
      async () =>
        (
          await db()
            .selectFrom("agent_turns")
            .select("status")
            .where("session_id", "=", sessionId)
            .execute()
        ).every((turn) => turn.status === "completed"),
      "the chat's turns to settle",
    );
  /** The sandbox the chat works in, as its machine names it. */
  const sandbox = async () =>
    (
      await db()
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
  /** What each setup event of the chat said, oldest first. */
  const setups = async () =>
    (
      await db()
        .selectFrom("project_events")
        .select(["payload", "waited"])
        .where("project_id", "=", projectId)
        .where("kind", "=", "session.workspace-setup")
        .orderBy("sequence")
        .execute()
    ).map((event) => {
      expect(event.waited).toBe(true);
      return SetupDetail.parse(
        z.object({ detail: z.unknown() }).parse(event.payload).detail,
      );
    });
  /** The phases of the chat's newest attempt, by name. */
  const phases = async () => {
    const attempt = await db()
      .selectFrom("agent_turn_attempts")
      .innerJoin("agent_turns", "agent_turns.id", "agent_turn_attempts.turn_id")
      .select("agent_turn_attempts.phases")
      .where("agent_turns.session_id", "=", sessionId)
      .orderBy("agent_turn_attempts.created_at", "desc")
      .executeTakeFirstOrThrow();
    return Phases.parse(attempt.phases).map((entry) => entry.phase);
  };
  const logged = () =>
    fs.existsSync(setupLog)
      ? fs.readFileSync(setupLog, "utf8").split("\n").filter(Boolean)
      : [];
  /** The setup workflow's runs, oldest first. */
  const prepared = async () =>
    db()
      .selectFrom("workflow_runs")
      .select(["status", "error", "result"])
      .where("project_id", "=", projectId)
      .where("workflow_name", "=", "prepareReview")
      .orderBy("created_at")
      .execute();
  /** What the agent sees in its checkout. */
  const SEE =
    "git rev-parse HEAD && cat node_modules/.installed && cat .review/PROCEDURE.md | tail -n 1";

  beforeAll(async () => {
    runId = randomUUID();
    await db()
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: "reviewPullRequests",
        provenance: {},
        status: "running",
        environment_name: "automation",
      })
      .execute();
  });

  it("first review: a sandbox is made, its base fetched by Git, and the turn waits for the command and the workflow's install", async () => {
    firstHead = await push({ "app.ts": "export const one = 1;\n" }, "Add app");
    sessionId = await deliver({
      content: `run ${SEE}`,
      workspace: { ref: PULL },
    });
    await waitFor(
      async () =>
        (await answers()).some((answer) => answer.includes(firstHead)),
      "the agent to see the pull request head",
    );
    // The agent started in a checkout that was set up: the install's
    // marker, in a folder Git ignores, and the trusted procedure.
    expect((await answers()).at(-1)).toBe(
      `exit=0\n${firstHead}\nlock-1\nThe trusted procedure.`,
    );
    await settled();
    expect(await setups()).toEqual([
      {
        reason: "created",
        environment: "review",
        workspace: { ref: PULL, commit: firstHead },
        previous: null,
        sandbox: "new",
      },
    ]);
    // The Environment's command first, then the workflow's install.
    expect(logged()).toEqual(["command created lock-1", "install lock-1"]);
    expect(await prepared()).toEqual([
      { status: "completed", error: null, result: { installed: true } },
    ]);
    // The base came from Work over Git (ADR 0353), with a token that ended.
    const fetched = await db()
      .selectFrom("workspace_checkouts")
      .select(["commit_sha", "revoked_at"])
      .where("session_id", "=", sessionId)
      .execute();
    expect(fetched.map((row) => row.commit_sha)).toEqual([firstHead]);
    expect(fetched.every((row) => row.revoked_at !== null)).toBe(true);
    expect(await phases()).toEqual(
      expect.arrayContaining([
        "sandbox.create",
        "workspace.checkout",
        "setup.environment",
        "setup.workflow",
      ]),
    );
    firstSandbox = await sandbox();
  }, 180_000);

  it("a push that changes no lockfile: the same sandbox, the checkout at the new head, what setup installed still there, and nothing run again", async () => {
    secondHead = await push({ "app.ts": "export const one = 2;\n" }, "Fix app");
    expect(
      await deliver({
        content: `run ${SEE}`,
        workspace: { ref: PULL, update: "reset" },
      }),
    ).toBe(sessionId);
    await waitFor(
      async () =>
        (await answers()).some((answer) => answer.includes(secondHead)),
      "the checkout to move to the new head",
    );
    expect((await answers()).at(-1)).toBe(
      `exit=0\n${secondHead}\nlock-1\nThe trusted procedure.`,
    );
    await settled();
    expect(await sandbox()).toBe(firstSandbox);
    expect((await setups()).at(-1)).toEqual({
      reason: "base-moved",
      environment: "review",
      workspace: { ref: PULL, commit: secondHead },
      previous: { commit: firstHead },
      sandbox: "kept",
    });
    // Neither the Environment's command nor the install ran again.
    expect(logged()).toEqual(["command created lock-1", "install lock-1"]);
    expect((await prepared()).at(-1)).toEqual({
      status: "completed",
      error: null,
      result: { installed: false },
    });
    // No sandbox was made: the base was fetched into the checkout it had,
    // and the turn waited for the workflow alone.
    const timed = await phases();
    expect(timed).toEqual(
      expect.arrayContaining(["workspace.checkout", "setup.workflow"]),
    );
    expect(timed).not.toContain("sandbox.create");
    expect(timed).not.toContain("setup.environment");
  }, 180_000);

  it("a push that changes the lockfile: the workflow asks for the setup's network, and gets a new sandbox, the command and its install", async () => {
    thirdHead = await push(
      { "pnpm-lock.yaml": "lock-2\n" },
      "Add a dependency",
    );
    expect(
      await deliver({
        content: `run ${SEE}`,
        workspace: { ref: PULL, update: "reset" },
      }),
    ).toBe(sessionId);
    await waitFor(
      async () =>
        (await answers()).some((answer) => answer.includes(thirdHead)),
      "the checkout to move to the new head",
      120_000,
    );
    expect((await answers()).at(-1)).toBe(
      `exit=0\n${thirdHead}\nlock-2\nThe trusted procedure.`,
    );
    await settled();
    secondSandbox = await sandbox();
    expect(secondSandbox).not.toBe(firstSandbox);
    // Asked of the kept sandbox, as every setup is.
    expect((await setups()).at(-1)).toEqual({
      reason: "base-moved",
      environment: "review",
      workspace: { ref: PULL, commit: thirdHead },
      previous: { commit: secondHead },
      sandbox: "kept",
    });
    expect(logged()).toEqual([
      "command created lock-1",
      "install lock-1",
      "command base-moved lock-2",
      "install lock-2",
    ]);
    expect((await prepared()).at(-1)).toEqual({
      status: "completed",
      error: null,
      result: { installed: true },
    });
    expect(await phases()).toEqual(
      expect.arrayContaining([
        "sandbox.create",
        "workspace.checkout",
        "setup.environment",
        "setup.workflow",
      ]),
    );
  }, 240_000);

  it("after idle release: a later turn gets a new sandbox, set up again", async () => {
    expect(
      await sessions().releaseIdleWorkspaces({
        now: new Date(Date.now() + 10 * 60_000),
      }),
    ).toBe(1);
    const seen = replyOf(
      await sessions().sendMessage(
        identity,
        projectId,
        sessionId,
        `run ${SEE}`,
      ),
    ).content;
    expect(seen).toBe(`exit=0\n${thirdHead}\nlock-2\nThe trusted procedure.`);
    await settled();
    expect(await sandbox()).not.toBe(secondSandbox);
    expect((await setups()).at(-1)).toEqual({
      reason: "rebuilt",
      environment: "review",
      workspace: { ref: PULL, commit: thirdHead },
      previous: null,
      sandbox: "new",
    });
    expect(logged().slice(4)).toEqual([
      "command rebuilt lock-2",
      "install lock-2",
    ]);
    expect((await prepared()).map((run) => run.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    // Every setup event's runs ended before its turn's agent started, and
    // nothing of a setup is left on the chat.
    expect(
      (
        await db()
          .selectFrom("agent_sessions")
          .select("setup_run")
          .where("id", "=", sessionId)
          .executeTakeFirstOrThrow()
      ).setup_run,
    ).toBeNull();
  }, 180_000);
  it("its subagents share the workspace, and each finding they submit is stamped with its commit and reaches the posting workflow as it is recorded", async () => {
    const reviewSandbox = await sandbox();
    // A panel: the reviewer starts two subagents, each with one aspect to
    // check, and each hands in a typed finding.
    const subagent = (title: string) =>
      `tool spawn_subsession ${JSON.stringify({
        title,
        task: `Check ${title}.\ntool submit_result ${JSON.stringify({ name: "finding", value: { title } })}`,
      })}`;
    await sessions().sendMessage(
      identity,
      projectId,
      sessionId,
      `${subagent("correctness")} ;; ${subagent("security")}`,
    );
    const panel = async () =>
      db()
        .selectFrom("agent_sessions")
        .select(["id", "title", "workspace_session_id", "sandbox_id"])
        .where("parent_session_id", "=", sessionId)
        .orderBy("created_at")
        .execute();
    const posted = () =>
      fs.existsSync(findingsLog)
        ? fs
            .readFileSync(findingsLog, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) =>
              z
                .object({
                  title: z.string(),
                  commit: z.string().nullable(),
                  reviewer: z.string(),
                  panel: z.array(z.string()),
                })
                .parse(JSON.parse(line)),
            )
        : [];
    await waitFor(
      async () => posted().length === 2,
      "both findings to reach the posting workflow",
      120_000,
    );
    const subagents = await panel();
    expect(subagents.map((child) => child.title).sort()).toEqual([
      "correctness",
      "security",
    ]);
    // They work in the reviewer's workspace: its sandbox, not their own.
    const parent = await db()
      .selectFrom("agent_sessions")
      .select("sandbox_id")
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    for (const child of subagents) {
      expect(child.workspace_session_id).toBe(sessionId);
      expect(child.sandbox_id).toBe(parent.sandbox_id);
    }
    expect(await sandbox()).toBe(reviewSandbox);
    // Each finding was posted as it was recorded, stamped with the commit
    // the workspace stood on, by the subagent that submitted it.
    const findings = posted();
    expect(findings.map((finding) => finding.title).sort()).toEqual([
      "correctness",
      "security",
    ]);
    expect(findings.map((finding) => finding.commit)).toEqual([
      thirdHead,
      thirdHead,
    ]);
    expect(findings.map((finding) => finding.reviewer).sort()).toEqual(
      subagents.map((child) => child.id).sort(),
    );
    // Reading the review's chat with its family finds the whole panel's.
    expect(
      findings.some(
        (finding) =>
          [...finding.panel].sort().join() ===
          subagents
            .map((child) => child.id)
            .sort()
            .join(),
      ),
    ).toBe(true);
    // No setup ran for a subagent: the workspace was set up for its chat.
    expect(await setups()).toHaveLength(4);
  }, 180_000);
});
