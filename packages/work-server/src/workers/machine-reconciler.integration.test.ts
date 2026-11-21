import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerNodesService } from "@catamorphic/core";
import { sql } from "kysely";
import pg from "pg";
import { expect, it } from "vitest";
import type { MachinesHook } from "../machines/contract.js";
import { plannedMachine } from "../machines/sequencer.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { dropTestDatabase, testServerOptions } from "../test-support.js";
import { WorkWorkerRegistry } from "./worker-registry.js";

const OPERATOR_SECRET = "operator-secret-shared-by-every-test-replica";

/**
 * The machines hook on two control-plane replicas (issue #154, ADR 0347):
 * however their passes overlap, each person gets one machine.
 */
it.skipIf(!process.env.DATABASE_URL)(
  "two replicas planning at once make one machine per person",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-reconciler-"));
    const servers: WorkServer[] = [];
    // Its own database: a deployment's replicas share one origin and
    // secret, which other suites on this server do not.
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    const database = `work_reconciler_${randomBytes(4).toString("hex")}`;
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
    databaseUrl.pathname = `/${database}`;

    // The platform: one machine per idempotency key, whoever asks and
    // however often. Work repeats a create with its key until it hears a
    // ref, so two replicas may ask for one machine; they get the same one.
    const created: Array<{ replica: string; name: string; key: string }> = [];
    const calls: Array<{ replica: string; name: string; key: string }> = [];
    // A platform call that waits until the test lets it finish.
    let hold: { entered: () => void; release: Promise<void> } | undefined;
    // The host's plan, the same code on every replica: one machine for
    // every active person.
    const hook = (replica: string): MachinesHook => ({
      plan: async ({ people }) =>
        people
          .filter((person) => person.active)
          .map((person) => ({
            name: `desk-${person.id
              .toLowerCase()
              .replace(/[^a-z0-9]/g, "")
              .slice(0, 40)}`,
            for: [{ user: person.id }],
          })),
      create: async ({ name, enrollment }) => {
        const key = enrollment.idempotencyKey;
        calls.push({ replica, name, key });
        if (created.some((machine) => machine.key === key))
          return { ref: `vm-${name}` };
        created.push({ replica, name, key });
        const held = hold;
        if (held) {
          hold = undefined;
          held.entered();
          await held.release;
        } else {
          // Slow enough that concurrent passes overlap.
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { ref: `vm-${name}` };
      },
      destroy: async () => ({ done: true }),
    });
    try {
      for (const replica of ["a", "b"]) {
        servers.push(
          await createWorkServer({
            ...testServerOptions({
              dataDir: path.join(dir, replica),
              publicBases: ["https://reconciler.example.test"],
              env: {
                DATABASE_URL: databaseUrl.toString(),
                WORK_SECRET: "reconciler-test-secret-with-at-least-32-chars",
                WORK_VAULT_KEY: Buffer.alloc(32, 3).toString("base64"),
                // Every replica of a deployment shares it.
                WORK_OPERATOR_SECRET: OPERATOR_SECRET,
                WORK_MACHINE_NAME: replica,
                WORK_CONTROL_PLANE_WORKLOADS: "workflow",
                WORK_FAKE_AGENT: "1",
                PATH: process.env.PATH,
              },
            }),
            hooks: { machines: hook(replica) },
          }),
        );
      }
      const [a, b] = servers;
      if (!a || !b) throw new Error("Both replicas must boot");
      const db = a.catamorphic.core.db;
      const operatorOf = (server: WorkServer) => (url: string) =>
        server.operatorApp.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${OPERATOR_SECRET}` },
        });
      const onA = operatorOf(a);
      const onB = operatorOf(b);
      const addMembers = async (names: string[]) => {
        for (const username of names) {
          await a.workAuth.createLocalUser({
            username,
            name: username,
            password: "correct horse battery staple",
            email: `${username}@example.com`,
          });
        }
      };

      // The replicas' own first passes found nobody; both now plan together.
      await addMembers(["ada", "grace", "edsger"]);
      const together = await Promise.all([
        onA("/_work/operator/machines/plan"),
        onB("/_work/operator/machines/plan"),
        onA("/_work/operator/machines/plan"),
        onB("/_work/operator/machines/plan"),
      ]);
      for (const response of together) expect(response.statusCode).toBe(200);
      const first = created.map((entry) => entry.name);
      expect(first).toHaveLength(3);
      expect(new Set(first).size).toBe(3);

      // A replica stalls in a platform call past its lease and another
      // takes over. The newcomer finishes what the stalled one began, with
      // the keys it recorded, and the stalled one changes nothing more once
      // it wakes: still one machine per person.
      await addMembers(["barbara", "donald", "frances"]);
      let released: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        hold = {
          entered: resolve,
          release: new Promise<void>((done) => {
            released = done;
          }),
        };
      });
      const stalled = onA("/_work/operator/machines/plan");
      await entered;
      await sql`
        UPDATE replica_claims SET expires_at = now() - interval '1 second'
        WHERE name = ${`machine-reconciler:${SERVER_TENANT_ID}`}
      `.execute(db);
      const takeover = await onB("/_work/operator/machines/plan");
      expect(takeover.statusCode, takeover.body).toBe(200);
      released();
      expect((await stalled).statusCode).toBe(200);
      // A later pass anywhere has nothing left to do.
      const settled = (await onA("/_work/operator/machines/plan")).json();
      expect(settled).toMatchObject({ created: [], failed: [] });
      expect(created).toHaveLength(6);
      expect(new Set(created.map((machine) => machine.name)).size).toBe(6);
      // Every call for a name carried that name's one key.
      for (const machine of created)
        expect(
          new Set(
            calls
              .filter((call) => call.name === machine.name)
              .map((call) => call.key),
          ).size,
        ).toBe(1);
      const listed = (
        await a.operatorApp.inject({
          method: "GET",
          url: "/_work/operator/workers",
          headers: { authorization: `Bearer ${OPERATOR_SECRET}` },
        })
      ).json();
      expect(listed.plan).toMatchObject({ configured: true, error: null });
      expect(listed.workers).toHaveLength(6);
      for (const worker of listed.workers)
        expect(worker).toMatchObject({
          managed: true,
          state: "starting",
          ref: `vm-${worker.name}`,
        });

      // Intent for one machine: however many replicas record it at once,
      // one does, and all of them then ask create with its one key.
      const registries = [a, b].map(
        (server) =>
          new WorkWorkerRegistry({
            db: server.catamorphic.core.db,
            nodes: new WorkerNodesService(server.catamorphic.core.db),
            tenantId: SERVER_TENANT_ID,
            authorityId: "test",
            // Every replica of a deployment shares its secret.
            enrollmentSecret: "one-secret-shared-by-every-replica",
          }),
      );
      const recorded = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          registries[index % 2]?.machines.intend({
            machine: plannedMachine({ name: "desk-race" }),
          }),
        ),
      );
      expect(recorded.filter(Boolean)).toHaveLength(1);
      const enrollments = await Promise.all(
        registries.map((registry) =>
          registry.machines.enrollment({ name: "desk-race" }),
        ),
      );
      expect(enrollments[0]?.code).toMatch(/^wke_/);
      expect(enrollments[1]).toEqual(enrollments[0]);
    } finally {
      for (const server of servers) await server.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
      try {
        await dropTestDatabase({ admin, database });
      } finally {
        await admin.end();
      }
    }
  },
  180_000,
);
