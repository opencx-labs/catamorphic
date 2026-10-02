import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  EnvironmentBindingUnavailableError,
  EnvironmentIncompatibleError,
  type Identity,
  projectPrincipalIdentity,
} from "@catamorphic/core";
import { machineSignInHome } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { say, testServerOptions } from "../test-support.js";
import { signInOnMachine, signInRoot, signOutOnMachine } from "./sign-ins.js";
import { startWorkWorker } from "./worker-runtime.js";

/**
 * Members' own sign-ins stay on the machine they were made on (ADR 0199),
 * end to end: a member signs in to Claude Code on workers with the CLI's
 * own login (a stand-in that writes its credentials file), and a chat on
 * the `claude-code` agent runs the CLI (a stand-in speaking the Agent
 * SDK's stdio protocol) in its sandbox there, with `CLAUDE_CONFIG_DIR` at
 * that member's home on the machine and no gateway. The chat places only
 * on a machine that reports its owner's sign-in, its sandbox sees that one
 * home and no other, only the owner's own messages run on it, and nothing
 * of it ever reaches the control plane.
 */

const SECRET_ENV = `API_TOKEN=personal-${crypto.randomUUID()}\n`;
const TOKENS = {
  alice: `sk-ant-oat01-alice-${crypto.randomUUID()}`,
  aliceSecondBox: `sk-ant-oat01-alice2-${crypto.randomUUID()}`,
  bob: `sk-ant-oat01-bob-${crypto.randomUUID()}`,
};

const ENGINEER_ROLE = {
  version: 1,
  name: "Engineer",
  permissions: ["program:*"],
  agents: ["*"],
  workflows: ["*"],
  apps: ["*"],
  environments: ["*"],
  documents: [{ path: "store/**", access: "write" }],
};

let root: string;
let server: WorkServer;
let base: string;
let projectId: string;
const users: Record<"alice" | "bob", string> = { alice: "", bob: "" };
const workers: Array<Awaited<ReturnType<typeof startWorkWorker>>> = [];
const workerDirs: Record<string, string> = {};

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

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

/** Files under a directory whose bytes contain the text. */
function holding(directory: string, text: string): string[] {
  return filesUnder(directory).filter((file) =>
    fs.readFileSync(file).includes(text),
  );
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const credentials = (token: string) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      expiresAt: Date.now() + 8 * 60 * 60_000,
      scopes: ["user:inference"],
      subscriptionType: "max",
    },
  });

/**
 * `work worker sign-in claude-code --member <id>` on a worker: the CLI's
 * own login, here a stand-in that writes the file the real one writes.
 */
function signIn(input: { worker: string; member: string; token: string }) {
  const { exitCode } = signInOnMachine({
    dataDir: workerDirs[input.worker] ?? "",
    harness: "claude-code",
    member: input.member,
    spawn: (_command, _args, options) => {
      fs.writeFileSync(
        path.join(options.env.CLAUDE_CONFIG_DIR ?? "", ".credentials.json"),
        credentials(input.token),
        { mode: 0o600 },
      );
      return { status: 0, error: undefined };
    },
  });
  expect(exitCode).toBe(0);
}

const operatorSecret = () =>
  fs
    .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
    .trim();

async function operator(url: string, body: unknown) {
  return server.operatorApp.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${operatorSecret()}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
}

async function memberIdentity(who: "alice" | "bob"): Promise<Identity> {
  const identity = await server.catamorphic.core.memberships.identityForUser({
    tenantId: SERVER_TENANT_ID,
    externalUserId: users[who],
  });
  if (!identity) throw new Error(`${who} is not a member`);
  return identity;
}

const sessions = () => {
  const service = server.catamorphic.core.agentSessions;
  if (!service) throw new Error("Agent sessions are unavailable");
  return service;
};

/** What a machine reports to placement: its offer's capabilities. */
async function reported(worker: string): Promise<string[]> {
  const node = await server.catamorphic.core.db
    .selectFrom("worker_nodes")
    .select("descriptor")
    .where("id", "=", `worker.${worker}`)
    .executeTakeFirst();
  const descriptor: unknown = node?.descriptor;
  return typeof descriptor === "object" &&
    descriptor !== null &&
    "capabilities" in descriptor &&
    Array.isArray(descriptor.capabilities)
    ? descriptor.capabilities.filter(
        (capability): capability is string => typeof capability === "string",
      )
    : [];
}

async function enroll(input: {
  name: string;
  labels: Record<string, string>;
  access: unknown;
  trusted?: boolean;
  bin: string;
}) {
  const enrollment = await operator("/_work/operator/workers", {
    name: input.name,
    labels: input.labels,
    access: input.access,
    ...(input.trusted ? { trusted: true } : {}),
  });
  expect(enrollment.statusCode).toBe(201);
  const dataDir = path.join(root, input.name);
  workerDirs[input.name] = dataDir;
  workers.push(
    await startWorkWorker({
      controlPlaneUrl: base,
      dataDir,
      enrollmentCode: enrollment.json().code,
      execution: executionSettingsFromEnv({
        PATH: `${input.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        WORK_MAX_WORKSPACES: "4",
      }),
    }),
  );
  await waitFor(async () => {
    const machines = (
      await server.operatorApp.inject({
        method: "GET",
        url: "/_work/operator/machines",
        headers: { authorization: `Bearer ${operatorSecret()}` },
      })
    ).json();
    return machines.machines.some(
      (machine: { id: string; available: boolean }) =>
        machine.id === `worker.${input.name}` && machine.available,
    );
  }, `worker ${input.name} to connect`);
}

/** A turn that someone else delivered, once it settled. */
async function settledTurn(turnId: string) {
  await waitFor(async () => {
    const turn = await server.catamorphic.core.db
      .selectFrom("agent_turns")
      .select("status")
      .where("id", "=", turnId)
      .executeTakeFirstOrThrow();
    return ["completed", "failed", "interrupted"].includes(turn.status);
  }, "the delivered turn to settle");
  return server.catamorphic.core.db
    .selectFrom("agent_turns")
    .select(["status", "error"])
    .where("id", "=", turnId)
    .executeTakeFirstOrThrow();
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-sign-in-"));
  // The "image": the workers' sandboxes find `claude` on their PATH.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.copyFileSync(
    path.join(import.meta.dirname, "fake-claude-cli.ts"),
    path.join(bin, "claude"),
  );
  fs.chmodSync(path.join(bin, "claude"), 0o755);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = await createWorkServer(
    testServerOptions({
      dataDir: path.join(root, "control-plane"),
      publicBases: [base],
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        PATH: process.env.PATH,
      },
    }),
  );
  await server.app.listen({ port, host: "127.0.0.1" });

  const project = await operator("/_work/operator/projects", {
    name: "sign-ins",
    roles: [{ slug: "engineer", definition: ENGINEER_ROLE }],
    admission: {
      mode: "invitation_only",
      defaultRole: "engineer",
      approvedDomains: [],
    },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().project.id;
  for (const who of ["alice", "bob"] as const) {
    const user = await operator("/_work/operator/users", {
      username: who,
      name: who,
      email: `${who}@example.test`,
      password: "correct horse battery staple",
      memberships: [{ projectId, roles: ["engineer"] }],
    });
    expect(user.statusCode).toBe(201);
    users[who] = user.json().user.id;
  }
  await server.catamorphic.core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    "operator",
    {
      message: "Environments for members' own sign-ins",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            mine: {
              pool: { pool: "alice" },
              workloads: ["agent"],
              personalCredentials: true,
            },
            mine2: {
              pool: { pool: "alice2" },
              workloads: ["agent"],
              personalCredentials: true,
            },
            shared: {
              pool: { pool: "shared" },
              workloads: ["agent"],
              personalCredentials: true,
            },
            plain: { pool: { pool: "alice" }, workloads: ["agent"] },
          },
          defaultEnvironment: "plain",
        }),
      },
    },
  );

  // Alice's own machines, and a shared one whose people trust each other.
  // On her first machine Alice signed in, and so did Bob, who sat there.
  for (const [name, labels, access, trusted] of [
    ["alice-box", { pool: "alice" }, { people: ["alice@example.test"] }],
    ["alice-box-2", { pool: "alice2" }, { people: ["alice@example.test"] }],
    ["shared-box", { pool: "shared" }, { everyone: true }, true],
  ] as const) {
    workerDirs[name] = path.join(root, name);
    if (name !== "alice-box-2")
      signIn({ worker: name, member: users.alice, token: TOKENS.alice });
    if (name === "alice-box")
      signIn({ worker: name, member: users.bob, token: TOKENS.bob });
    await enroll({
      name,
      labels,
      access,
      bin,
      ...(trusted ? { trusted } : {}),
    });
  }
}, 180_000);

afterAll(async () => {
  await Promise.all(workers.map((running) => running.stop()));
  await server?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

describe("members' own sign-ins on the machine (ADR 0199)", () => {
  let sessionId = "";
  const agentId = () => `project:${projectId}:claude-code`;

  it("a machine reports who is signed in, never a value", async () => {
    expect(await reported("alice-box")).toEqual(
      expect.arrayContaining([
        "sign-ins",
        `sign-in:claude-code:${users.alice}`,
        `sign-in:claude-code:${users.bob}`,
      ]),
    );
    expect(await reported("alice-box-2")).toContain("sign-ins");
    expect(
      (await reported("alice-box-2")).some((entry) =>
        entry.startsWith("sign-in:"),
      ),
    ).toBe(false);
    const nodes = await server.catamorphic.core.db
      .selectFrom("worker_nodes")
      .selectAll()
      .execute();
    for (const token of Object.values(TOKENS))
      expect(JSON.stringify(nodes)).not.toContain(token);
  });

  it("runs Claude Code on the owner's own sign-in, from that machine's disk", async () => {
    const alice = await memberIdentity("alice");
    const catalog = await sessions().catalog({ identity: alice, projectId });
    const claude = catalog.items.find((item) => item.id === agentId());
    expect(claude).toMatchObject({ name: "Claude Code", available: true });
    // Her listed files still reach her own chats (ADR 0184).
    await server.catamorphic.core.personalEnvironments.replace({
      identity: alice,
      projectId,
      input: {
        files: [
          { path: ".env", content: Buffer.from(SECRET_ENV).toString("base64") },
        ],
      },
    });

    const session = await sessions().create(alice, projectId, {
      agentId: agentId(),
      environment: "mine",
    });
    sessionId = session.id;
    const report = await say({
      sessions: sessions(),
      identity: alice,
      projectId,
      sessionId,
      text: "report",
    });
    expect(JSON.parse(report.content)).toMatchObject({
      configDir: true,
      credentials: true,
      accessTokenSha256: sha256(TOKENS.alice),
      refreshToken: false,
      baseUrl: null,
      apiKey: null,
      apiKeyHelper: false,
    });

    // The sandbox sees her home on this machine and no one else's.
    const home = machineSignInHome({
      root: signInRoot(workerDirs["alice-box"] ?? ""),
      harness: "claude-code",
      member: users.alice,
    });
    const seen = await say({
      sessions: sessions(),
      identity: alice,
      projectId,
      sessionId,
      text: 'run: readlink "$CLAUDE_CONFIG_DIR" && ls -A "$(dirname "$CLAUDE_CONFIG_DIR")" && grep -c API_TOKEN .env',
    });
    expect(seen.content).toBe(`Done: ${home}\nclaude-code\n1\n`);
    expect(seen.content).not.toContain(users.bob);

    // Nothing of a sign-in leaves the machine: not the control plane's
    // disk or database, not an operation forwarded to the worker.
    const controlPlane = path.join(root, "control-plane");
    for (const token of Object.values(TOKENS))
      expect(holding(controlPlane, token)).toEqual([]);
    const forwarded = await server.catamorphic.core.db
      .selectFrom("remote_operations")
      .select(["operation", "response"])
      .execute();
    expect(JSON.stringify(forwarded)).not.toContain(TOKENS.alice);
    // The sign-in stays where she made it, unchanged.
    expect(holding(workerDirs["alice-box"] ?? "", TOKENS.alice)).toEqual([
      path.join(home, ".credentials.json"),
    ]);
  }, 120_000);

  it("places a chat only on a machine that reports its owner's sign-in", async () => {
    const alice = await memberIdentity("alice");
    const refused = await sessions()
      .create(alice, projectId, { agentId: agentId(), environment: "mine2" })
      .catch((error: unknown) => error);
    // No machine of that Environment reports her sign-in.
    expect(refused).toBeInstanceOf(EnvironmentBindingUnavailableError);

    // She signs in on that machine too; it reports it within seconds.
    signIn({
      worker: "alice-box-2",
      member: users.alice,
      token: TOKENS.aliceSecondBox,
    });
    await waitFor(
      async () =>
        (await reported("alice-box-2")).includes(
          `sign-in:claude-code:${users.alice}`,
        ),
      "the machine to report the new sign-in",
    );
    const session = await sessions().create(alice, projectId, {
      agentId: agentId(),
      environment: "mine2",
    });
    const report = await say({
      sessions: sessions(),
      identity: alice,
      projectId,
      sessionId: session.id,
      text: "report",
    });
    // That machine's own sign-in: each machine keeps its own.
    expect(JSON.parse(report.content)).toMatchObject({
      accessTokenSha256: sha256(TOKENS.aliceSecondBox),
    });

    // Signed out there, the chat's next turn is refused with the fix.
    expect(
      signOutOnMachine({
        dataDir: workerDirs["alice-box-2"] ?? "",
        harness: "claude-code",
        member: users.alice,
      }),
    ).toBe(true);
    await waitFor(
      async () =>
        !(await reported("alice-box-2")).includes(
          `sign-in:claude-code:${users.alice}`,
        ),
      "the machine to stop reporting the sign-in",
    );
    const after = await say({
      sessions: sessions(),
      identity: alice,
      projectId,
      sessionId: session.id,
      text: "report",
    });
    // Every turn is admitted again: this one finds no machine for her.
    expect(after.turn.status).toBe("failed");
    expect(after.content).toContain("No machine for Environment 'mine2'");
  }, 120_000);

  it("runs only the owner's own messages on their sign-in", async () => {
    const alice = await memberIdentity("alice");
    // An administrator's message (the host's root identity) is refused.
    const admin: Identity = {
      tenantId: SERVER_TENANT_ID,
      externalUserId: `admin-${crypto.randomUUID()}`,
    };
    const delivered = await sessions().deliver(admin, projectId, sessionId, {
      content: "report",
      author: { kind: "user", externalUserId: admin.externalUserId },
      mode: "queue",
    });
    if (!delivered.turnId) throw new Error("The delivery started no turn");
    const refused = await settledTurn(delivered.turnId);
    expect(refused.status).toBe("failed");
    expect(JSON.stringify(refused.error)).toContain(
      "This chat runs on its owner's own Claude Code sign-in, so only they can send it messages.",
    );

    // So is an automation's delivery into her chat, even on her behalf.
    const runId = crypto.randomUUID();
    await server.catamorphic.core.db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: "nudge",
        provenance: {},
        status: "running",
        environment_name: "mine",
      })
      .execute();
    const turnsBefore = await server.catamorphic.core.db
      .selectFrom("agent_turns")
      .select("id")
      .where("session_id", "=", sessionId)
      .execute();
    await server.catamorphic.core.capabilities.call(
      "catamorphic.sessions",
      "deliver",
      { caller: alice, projectId, runId, workflowName: "nudge" },
      {
        sessionId,
        content: "report",
        mode: "queue",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    const automated = (
      await server.catamorphic.core.db
        .selectFrom("agent_turns")
        .select("id")
        .where("session_id", "=", sessionId)
        .where(
          "id",
          "not in",
          turnsBefore.map((turn) => turn.id),
        )
        .execute()
    )[0];
    if (!automated) throw new Error("The automation started no turn");
    const automation = await settledTurn(automated.id);
    expect(automation.status).toBe("failed");
    expect(JSON.stringify(automation.error)).toContain(
      "only they can send it messages",
    );

    // Her own next message runs on it again.
    const again = await say({
      sessions: sessions(),
      identity: alice,
      projectId,
      sessionId,
      text: "report",
    });
    expect(JSON.parse(again.content)).toMatchObject({
      accessTokenSha256: sha256(TOKENS.alice),
    });
  }, 120_000);

  it("refuses Environments that do not allow it, or share a machine", async () => {
    const alice = await memberIdentity("alice");
    const plain = await sessions()
      .create(alice, projectId, { agentId: agentId(), environment: "plain" })
      .catch((error: unknown) => error);
    expect(plain).toBeInstanceOf(EnvironmentIncompatibleError);
    expect(String(plain)).toContain(
      `does not allow personal credentials. Add "personalCredentials": true`,
    );
    const shared = await sessions()
      .create(alice, projectId, { agentId: agentId(), environment: "shared" })
      .catch((error: unknown) => error);
    expect(shared).toBeInstanceOf(EnvironmentIncompatibleError);
    expect(String(shared)).toContain("WORK_PERSONAL_CREDENTIALS=accept");
  }, 60_000);

  it("refuses a project chat a member's sign-in", async () => {
    const principal = projectPrincipalIdentity({
      tenantId: SERVER_TENANT_ID,
      projectId,
      environment: "mine",
    });
    const refused = await sessions()
      .create(principal, projectId, {
        agentId: agentId(),
        environment: "mine",
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toMatch(
      /only a member's own chats|own chats|No machine for Environment/,
    );
  }, 60_000);
});
