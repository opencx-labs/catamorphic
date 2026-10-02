import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Identity } from "@catamorphic/core";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import pg from "pg";
import { expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
import {
  createTestDatabase,
  enqueue,
  testServerOptions,
} from "./test-support.js";

/**
 * Disposable replicas (ADR 0190), end to end on network Postgres: replica a,
 * its own process, holds a paused durable run and a chat. It is killed with
 * SIGKILL and its data directory deleted. A brand-new replica c recovers
 * both: the run resumes to completion there, the chat continues from its
 * last checkpoint, and the tenant's run capacity is freed. Replica b only
 * serves the API; a machine label keeps the project's work off it.
 */

const APPROVAL = `import {
  type BoundaryContext,
  defineWorkflow,
  type PauseResult,
} from "@catamorphic/workflow";

type Order = { order: string };
type Approval = { approved: boolean };

/** @displayname Await approval */
export const awaitApproval = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    /** @displayname Wait for a decision */
    defineBoundary({
      run: ({ input, pause }: BoundaryContext<Order>) =>
        pause<Approval, Order>({ timeout: "24h", state: input }),
    }),
    /** @displayname Record the decision */
    defineBoundary({
      run: ({ input }: BoundaryContext<PauseResult<Approval, Order>>) => ({
        order: input.state.order,
        approved: input.reason === "resumed" && input.value.approved,
      }),
    }),
  ],
}));
`;

const PUBLIC_URL = "https://recovery.example.test";

it.skipIf(!process.env.DATABASE_URL)(
  "a fresh replica finishes a killed replica's paused run and continues its chat",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "work-recovery-"));
    const database = await createTestDatabase("work_recovery");
    const env = (name: string, labels?: string) => ({
      DATABASE_URL: database.url,
      WORK_SECRET: "recovery-test-secret-with-at-least-32-characters",
      WORK_OPERATOR_SECRET: "recovery-test-operator-secret-with-32-characters",
      WORK_VAULT_KEY: Buffer.alloc(32, 11).toString("base64"),
      // Trusted test replicas run agents as subprocesses (ADR 0164).
      WORK_TRUST_CONTROL_PLANE_AGENTS: "1",
      WORK_FAKE_AGENT: "1",
      WORK_MACHINE_NAME: name,
      ...(labels ? { WORK_MACHINE_LABELS: labels } : {}),
      PATH: process.env.PATH,
    });
    const inProcess = (name: string, labels?: string) =>
      createWorkServer(
        testServerOptions({
          dataDir: path.join(root, name),
          publicBases: [PUBLIC_URL],
          env: env(name, labels),
        }),
      );
    const servers = new Map<string, WorkServer>();
    let child: ChildProcess | undefined;
    try {
      const b = await inProcess("b");
      servers.set("b", b);
      // Replica a runs in its own process, so it can die for real.
      const started = await startReplicaProcess({
        env: {
          ...env("a", "pool=recovery"),
          WORK_DATA_DIR: path.join(root, "a"),
          WORK_PUBLIC_URL: PUBLIC_URL,
          WORK_MDNS: "off",
        },
      });
      child = started.child;
      const aNode = started.node;

      // A project whose work runs only on machines labelled pool=recovery,
      // a member, and a one-run budget.
      const account = await b.workAuth.createLocalUser({
        username: "recoverymember",
        name: "Recovery member",
        password: "recovery-member-test-password",
      });
      const identity: Identity = {
        tenantId: SERVER_TENANT_ID,
        externalUserId: account.id,
      };
      const core = b.catamorphic.core;
      const project = await core.projects.create(identity, {
        name: "Recovery",
      });
      const deployed = await core.deployment.deploy(
        identity.tenantId,
        project.id,
        identity.externalUserId,
        {
          message: "Await approvals",
          files: {
            ".work/project.json": JSON.stringify({
              environments: {
                primary: {
                  pool: { pool: "recovery" },
                  workloads: ["agent", "workflow"],
                },
              },
              defaultEnvironment: "primary",
            }),
            ".work/package.json": JSON.stringify({
              name: "recovery-work",
              private: true,
              workspaces: ["workflows"],
            }),
            ".work/workflows/package.json": JSON.stringify({
              name: "@recovery/workflows",
              private: true,
              type: "module",
              dependencies: {
                "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
              },
            }),
            ".work/workflows/approval.ts": APPROVAL,
            ".work/roles/member.json": JSON.stringify({
              version: 1,
              name: "Member",
              agents: ["*"],
              environments: ["primary"],
            }),
          },
        },
      );
      expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
      await core.memberships.grant({
        identity,
        projectId: project.id,
        externalUserId: identity.externalUserId,
        roles: ["member"],
      });
      await core.tenantPolicies.upsert({
        tenantId: SERVER_TENANT_ID,
        maxActiveRuns: 1,
      });

      // The run pauses on replica a.
      const run = await core.runs.triggerProduction({
        identity,
        projectId: project.id,
        workflowName: "awaitApproval",
        input: { order: "order-7" },
      });
      await expect
        .poll(
          async () => (await core.runs.get({ identity, runId: run.id })).status,
          { timeout: 90_000, interval: 500 },
        )
        .toBe("waiting");
      const placement = async () =>
        core.db
          .selectFrom("workflow_runs as run")
          .innerJoin(
            "execution_allocations as allocation",
            "allocation.id",
            "run.allocation_id",
          )
          .select(["allocation.worker_node_id", "allocation.status"])
          .where("run.id", "=", run.id)
          .executeTakeFirstOrThrow();
      expect((await placement()).worker_node_id).toBe(aNode);
      // The run holds the tenant's only slot.
      await expect(
        core.runs.triggerProduction({
          identity,
          projectId: project.id,
          workflowName: "awaitApproval",
          input: { order: "order-8" },
        }),
      ).rejects.toThrow(/active run/i);

      // A chat on replica a saves a file; its turn checkpoints it.
      const member = await core.memberships.identityFor({
        ...identity,
        projectId: project.id,
      });
      if (!member) throw new Error("Membership missing");
      const sessions = core.agentSessions;
      if (!sessions) throw new Error("Agent sessions are not configured");
      const session = await sessions.create(member, project.id);
      const replies = async () =>
        (await sessions.transcript(member, project.id, session.id))
          .filter((message) => message.role === "assistant")
          .map((message) => message.content);
      await enqueue({
        sessions,
        identity: member,
        projectId: project.id,
        sessionId: session.id,
        text: "write-file note.txt saved before the crash",
      });
      await expect
        .poll(
          async () =>
            (
              await core.db
                .selectFrom("agent_turns")
                .select("status")
                .where("session_id", "=", session.id)
                .executeTakeFirst()
            )?.status,
          { timeout: 60_000, interval: 250 },
        )
        .toBe("completed");
      const chatNode = async () =>
        (
          await core.db
            .selectFrom("agent_sessions as session")
            .innerJoin(
              "execution_allocations as allocation",
              "allocation.id",
              "session.allocation_id",
            )
            .select(["allocation.worker_node_id", "allocation.status"])
            .where("session.id", "=", session.id)
            .executeTakeFirstOrThrow()
        ).worker_node_id;
      expect(await chatNode()).toBe(aNode);

      // Replica a dies: SIGKILL, nothing given back, its disk deleted. Its
      // lease is then left to lapse past the grace period.
      child.kill("SIGKILL");
      await new Promise((resolve) => child?.once("exit", resolve));
      child = undefined;
      await removeDataDir(path.join(root, "a"));
      const admin = new pg.Client({ connectionString: database.url });
      await admin.connect();
      try {
        await admin.query(
          "UPDATE catamorphic.worker_nodes SET lease_expires_at = now() - interval '5 minutes' WHERE id = $1",
          [aNode],
        );
      } finally {
        await admin.end();
      }

      // A brand-new replica, with a new data directory, takes a's work.
      const c = await inProcess("c", "pool=recovery");
      servers.set("c", c);
      const cNode: string = (
        await c.app.inject({ method: "GET", url: "/healthz" })
      ).json().machine.id;
      await expect
        .poll(async () => (await placement()).worker_node_id, {
          timeout: 30_000,
          interval: 500,
        })
        .toBe(cNode);
      await expect
        .poll(
          async () =>
            await core.db
              .selectFrom("worker_nodes")
              .select("id")
              .where("id", "=", aNode)
              .executeTakeFirst(),
          { timeout: 30_000, interval: 500 },
        )
        .toBeUndefined();

      // The paused run resumes and completes on the new replica.
      const pause = await core.db
        .selectFrom("workflow_pauses")
        .select("id")
        .where("run_id", "=", run.id)
        .where("status", "=", "open")
        .executeTakeFirstOrThrow();
      await core.runs.resumePause({
        identity,
        runId: run.id,
        pauseId: pause.id,
        idempotencyKey: `approve-${randomUUID()}`,
        value: { approved: true },
      });
      await expect
        .poll(
          async () => (await core.runs.get({ identity, runId: run.id })).status,
          { timeout: 90_000, interval: 500 },
        )
        .toBe("completed");
      expect((await core.runs.get({ identity, runId: run.id })).result).toEqual(
        { order: "order-7", approved: true },
      );

      // Its slot is free again.
      const next = await core.runs.triggerProduction({
        identity,
        projectId: project.id,
        workflowName: "awaitApproval",
        input: { order: "order-8" },
      });
      await core.runs.cancel({ identity, runId: next.id });

      // The chat continues on the new replica from its last checkpoint.
      await enqueue({
        sessions,
        identity: member,
        projectId: project.id,
        sessionId: session.id,
        text: "read-file note.txt",
      });
      await expect
        .poll(replies, { timeout: 60_000, interval: 500 })
        .toEqual([expect.any(String), "saved before the crash"]);
      expect(await chatNode()).toBe(cNode);
    } finally {
      child?.kill("SIGKILL");
      for (const server of servers.values()) await server.shutdown();
      await removeDataDir(root);
      await database.drop();
    }
  },
  300_000,
);

/** Start a replica process and wait for it to report its machine. */
async function startReplicaProcess(args: {
  env: Record<string, string | undefined>;
}): Promise<{ child: ChildProcess; node: string }> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "replica-process.fixture.ts")],
    { env: args.env, stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout ?? process.stdin });
  const node = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The replica process did not start")),
      60_000,
    );
    child.once("exit", (code) =>
      reject(new Error(`The replica process exited with ${code}`)),
    );
    lines.on("line", (line) => {
      // Its request log shares stdout: only the ready line names a node.
      if (!line.startsWith('{"node"')) return;
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "node" in parsed &&
        typeof parsed.node === "string"
      ) {
        clearTimeout(timer);
        resolve(parsed.node);
      }
    });
  });
  return { child, node };
}

/** Deployment snapshots in workflow sandboxes are read-only. */
async function removeDataDir(dir: string): Promise<void> {
  const writable = async (current: string): Promise<void> => {
    await fs.chmod(current, 0o700).catch(() => {});
    const entries = await fs
      .readdir(current, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries)
      if (entry.isDirectory()) await writable(path.join(current, entry.name));
  };
  await writable(dir);
  await fs.rm(dir, { recursive: true, force: true });
}
