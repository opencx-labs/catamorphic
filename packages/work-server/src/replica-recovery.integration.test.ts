import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Identity } from "@catamorphic/core";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import pg from "pg";
import { expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
import { createTestDatabase, testServerOptions } from "./test-support.js";

/**
 * Disposable replicas (ADR 0190), end to end on network Postgres: a replica
 * holding a paused durable run and a chat dies, its data directory with it.
 * A brand-new replica recovers both: the run resumes to completion there,
 * the chat continues from its last checkpoint, and the tenant's run
 * capacity is freed.
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

const MEMBER_ROLE = {
  version: 1,
  name: "Member",
  agents: ["*"],
  environments: ["default"],
};

it.skipIf(!process.env.DATABASE_URL)(
  "a fresh replica finishes a lost replica's paused run and continues its chat",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "work-recovery-"));
    const database = await createTestDatabase("work_recovery");
    const options = (name: string) =>
      testServerOptions({
        dataDir: path.join(root, name),
        publicBases: ["https://recovery.example.test"],
        env: {
          DATABASE_URL: database.url,
          WORK_SECRET: "recovery-test-secret-with-at-least-32-characters",
          WORK_OPERATOR_SECRET:
            "recovery-test-operator-secret-with-32-characters",
          WORK_VAULT_KEY: Buffer.alloc(32, 11).toString("base64"),
          // Trusted test replicas run agents as subprocesses (ADR 0164).
          WORK_TRUST_CONTROL_PLANE_AGENTS: "1",
          WORK_FAKE_AGENT: "1",
          WORK_MACHINE_NAME: name,
          PATH: process.env.PATH,
        },
      });
    const servers = new Map<string, WorkServer>();
    try {
      const a = await createWorkServer(options("a"));
      servers.set("a", a);
      const aNode: string = (
        await a.app.inject({ method: "GET", url: "/healthz" })
      ).json().machine.id;

      // A project with a durable workflow, a member, and a one-run budget.
      const account = await a.workAuth.createLocalUser({
        username: "recoverymember",
        name: "Recovery member",
        password: "recovery-member-test-password",
      });
      const identity: Identity = {
        tenantId: SERVER_TENANT_ID,
        externalUserId: account.id,
      };
      const project = await a.catamorphic.core.projects.create(identity, {
        name: "Recovery",
      });
      const deployed = await a.catamorphic.core.deployment.deploy(
        identity.tenantId,
        project.id,
        identity.externalUserId,
        {
          message: "Await approvals",
          files: {
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
            ".work/roles/member.json": JSON.stringify(MEMBER_ROLE),
          },
        },
      );
      expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
      await a.catamorphic.core.memberships.grant({
        identity,
        projectId: project.id,
        externalUserId: identity.externalUserId,
        roles: ["member"],
      });
      await a.catamorphic.core.tenantPolicies.upsert({
        tenantId: SERVER_TENANT_ID,
        maxActiveRuns: 1,
      });

      // The run pauses on replica a.
      const run = await a.catamorphic.core.runs.triggerProduction({
        identity,
        projectId: project.id,
        workflowName: "awaitApproval",
        input: { order: "order-7" },
      });
      await expect
        .poll(
          async () =>
            (await a.catamorphic.core.runs.get({ identity, runId: run.id }))
              .status,
          { timeout: 90_000, interval: 500 },
        )
        .toBe("waiting");
      const placement = async (server: WorkServer) =>
        server.catamorphic.core.db
          .selectFrom("workflow_runs as run")
          .innerJoin(
            "execution_allocations as allocation",
            "allocation.id",
            "run.allocation_id",
          )
          .select(["allocation.worker_node_id", "allocation.status"])
          .where("run.id", "=", run.id)
          .executeTakeFirstOrThrow();
      expect((await placement(a)).worker_node_id).toBe(aNode);
      // The run holds the tenant's only slot.
      await expect(
        a.catamorphic.core.runs.triggerProduction({
          identity,
          projectId: project.id,
          workflowName: "awaitApproval",
          input: { order: "order-8" },
        }),
      ).rejects.toThrow(/active run/i);

      // A chat on replica a saves a file; its turn checkpoints it.
      const memberOn = async (server: WorkServer) => {
        const member = await server.catamorphic.core.memberships.identityFor({
          ...identity,
          projectId: project.id,
        });
        if (!member) throw new Error("Membership missing");
        return member;
      };
      const sessions = (server: WorkServer) => {
        const service = server.catamorphic.core.agentSessions;
        if (!service) throw new Error("Agent sessions are not configured");
        return service;
      };
      const member = await memberOn(a);
      const session = await sessions(a).create(member, project.id);
      const replies = async (server: WorkServer) =>
        (
          await sessions(server).get(
            await memberOn(server),
            project.id,
            session.id,
          )
        ).messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content);
      await sessions(a).enqueueMessage(
        member,
        project.id,
        session.id,
        "write-file note.txt saved before the crash",
      );
      await expect
        .poll(() => replies(a), { timeout: 60_000, interval: 500 })
        .toHaveLength(1);
      await expect
        .poll(
          async () =>
            (
              await a.catamorphic.core.db
                .selectFrom("agent_turns")
                .select("status")
                .where("session_id", "=", session.id)
                .executeTakeFirstOrThrow()
            ).status,
          { timeout: 30_000, interval: 250 },
        )
        .toBe("completed");

      // Replica a dies: its process stops without giving anything back (its
      // lease is out of its reach), and its data directory is deleted.
      const admin = new pg.Client({ connectionString: database.url });
      await admin.connect();
      try {
        await admin.query(
          "UPDATE catamorphic.worker_nodes SET lease_token = gen_random_uuid(), lease_expires_at = now() + interval '1 hour' WHERE id = $1",
          [aNode],
        );
        await a.shutdown();
        servers.delete("a");
        await removeDataDir(path.join(root, "a"));
        // Long enough ago that no grace period is left.
        await admin.query(
          "UPDATE catamorphic.worker_nodes SET lease_expires_at = now() - interval '5 minutes' WHERE id = $1",
          [aNode],
        );
      } finally {
        await admin.end();
      }

      // A brand-new replica, with a new data directory, recovers a's work.
      const c = await createWorkServer(options("c"));
      servers.set("c", c);
      const cNode: string = (
        await c.app.inject({ method: "GET", url: "/healthz" })
      ).json().machine.id;
      expect(cNode).not.toBe(aNode);
      await expect
        .poll(async () => (await placement(c)).worker_node_id, {
          timeout: 30_000,
          interval: 500,
        })
        .toBe(cNode);
      expect(
        await c.catamorphic.core.db
          .selectFrom("worker_nodes")
          .select("id")
          .where("id", "=", aNode)
          .executeTakeFirst(),
      ).toBeUndefined();

      // The paused run resumes and completes on the new replica.
      const pause = await c.catamorphic.core.db
        .selectFrom("workflow_pauses")
        .select("id")
        .where("run_id", "=", run.id)
        .where("status", "=", "open")
        .executeTakeFirstOrThrow();
      await c.catamorphic.core.runs.resumePause({
        identity,
        runId: run.id,
        pauseId: pause.id,
        idempotencyKey: `approve-${randomUUID()}`,
        value: { approved: true },
      });
      await expect
        .poll(
          async () =>
            (await c.catamorphic.core.runs.get({ identity, runId: run.id }))
              .status,
          { timeout: 90_000, interval: 500 },
        )
        .toBe("completed");
      expect(
        (await c.catamorphic.core.runs.get({ identity, runId: run.id })).result,
      ).toEqual({ order: "order-7", approved: true });

      // Its slot is free again.
      const next = await c.catamorphic.core.runs.triggerProduction({
        identity,
        projectId: project.id,
        workflowName: "awaitApproval",
        input: { order: "order-8" },
      });
      await c.catamorphic.core.runs.cancel({ identity, runId: next.id });

      // The chat continues on the new replica from its last checkpoint.
      await sessions(c).enqueueMessage(
        await memberOn(c),
        project.id,
        session.id,
        "read-file note.txt",
      );
      await expect
        .poll(() => replies(c), { timeout: 60_000, interval: 500 })
        .toEqual([expect.any(String), "saved before the crash"]);
      const chat = await c.catamorphic.core.db
        .selectFrom("agent_sessions as session")
        .innerJoin(
          "execution_allocations as allocation",
          "allocation.id",
          "session.allocation_id",
        )
        .select(["allocation.worker_node_id", "allocation.status"])
        .where("session.id", "=", session.id)
        .executeTakeFirstOrThrow();
      expect(chat).toEqual({ worker_node_id: cNode, status: "active" });
    } finally {
      for (const server of servers.values()) await server.shutdown();
      await removeDataDir(root);
      await database.drop();
    }
  },
  300_000,
);

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
