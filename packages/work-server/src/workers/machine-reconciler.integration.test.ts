import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerNodesService } from "@catamorphic/core";
import { sql } from "kysely";
import pg from "pg";
import { expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { dropTestDatabase, testServerOptions } from "../test-support.js";
import type { MachineProvisioner } from "./machine-rules.js";
import { WorkWorkerRegistry } from "./worker-registry.js";

/**
 * Machine rules on two control-plane replicas (issue #154): however their
 * passes overlap, each person gets one machine.
 */
it.skipIf(!process.env.DATABASE_URL)(
  "two replicas reconciling at once provision one machine per person",
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

    const created: Array<{ replica: string; name: string }> = [];
    // A platform call that waits until the test lets it finish.
    let hold: { entered: () => void; release: Promise<void> } | undefined;
    const provisioner = (replica: string): MachineProvisioner => ({
      create: async ({ name }) => {
        created.push({ replica, name });
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
      destroy: async () => {},
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
                WORK_MACHINE_NAME: replica,
                WORK_CONTROL_PLANE_WORKLOADS: "workflow",
                WORK_FAKE_AGENT: "1",
                PATH: process.env.PATH,
              },
            }),
            hooks: { machineProvisioner: provisioner(replica) },
          }),
        );
      }
      const [a, b] = servers;
      if (!a || !b) throw new Error("Both replicas must boot");
      const db = a.catamorphic.core.db;
      const operatorOf = async (server: WorkServer, replica: string) => {
        const secret = (
          await fs.readFile(path.join(dir, replica, "operator-secret"), "utf8")
        ).trim();
        return (url: string) =>
          server.operatorApp.inject({
            method: "POST",
            url,
            headers: { authorization: `Bearer ${secret}` },
          });
      };
      const onA = await operatorOf(a, "a");
      const onB = await operatorOf(b, "b");
      const addMembers = async (names: string[]) => {
        for (const username of names) {
          const user = await a.workAuth.createLocalUser({
            username,
            name: username,
            password: "correct horse battery staple",
            email: `${username}@example.com`,
          });
          await sql`
            INSERT INTO work_accounts (user_id, directory_groups, directory_checked_at)
            VALUES (${user.id}, ${JSON.stringify(["eng@example.com"])}::jsonb, now())
          `.execute(db);
        }
      };

      // The rule goes straight into the table, so no pass runs until both
      // replicas start theirs together.
      await addMembers(["ada", "grace", "edsger"]);
      await sql`
        INSERT INTO work_machine_rules (name, tenant_id, definition)
        VALUES ('desk', ${SERVER_TENANT_ID}, ${JSON.stringify({
          group: "eng@example.com",
          machines: "each-member",
          class: "standard-4",
        })}::jsonb)
      `.execute(db);
      const together = await Promise.all([
        onA("/_work/operator/machine-rules/reconcile"),
        onB("/_work/operator/machine-rules/reconcile"),
        onA("/_work/operator/machine-rules/reconcile"),
        onB("/_work/operator/machine-rules/reconcile"),
      ]);
      for (const response of together) expect(response.statusCode).toBe(200);
      const first = created.map((entry) => entry.name);
      expect(first).toHaveLength(3);
      expect(new Set(first).size).toBe(3);

      // A replica stalls in a platform call past its lease and another
      // takes over. The newcomer skips the stalled replica's machine, and
      // the stalled one changes nothing more once it wakes.
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
      const stalled = onA("/_work/operator/machine-rules/reconcile");
      await entered;
      await sql`
        UPDATE work_machine_reconciler SET expires_at = now() - interval '1 second'
      `.execute(db);
      const takeover = (
        await onB("/_work/operator/machine-rules/reconcile")
      ).json();
      released();
      const woke = (await stalled).json();
      const second = created.slice(3);
      expect(second).toHaveLength(3);
      expect(new Set(second.map((entry) => entry.name)).size).toBe(3);
      // The stalled replica finishes the machine it was creating and stops.
      const [stalledMachine] = second;
      expect(stalledMachine?.replica).toBe("a");
      expect(woke.created).toEqual([stalledMachine?.name]);
      expect(takeover.created).toHaveLength(2);
      expect(takeover.created).not.toContain(stalledMachine?.name);
      expect(second.map((entry) => entry.replica).sort()).toEqual([
        "a",
        "b",
        "b",
      ]);
      // A later pass anywhere has nothing left to do.
      const settled = (
        await onA("/_work/operator/machine-rules/reconcile")
      ).json();
      expect(settled).toMatchObject({ created: [], failed: [] });
      expect(created).toHaveLength(6);

      // Enrollment codes for one machine: however many replicas ask at
      // once, one gets a code.
      const registries = [a, b].map(
        (server) =>
          new WorkWorkerRegistry({
            db: server.catamorphic.core.db,
            nodes: new WorkerNodesService(server.catamorphic.core.db),
            tenantId: SERVER_TENANT_ID,
            authorityId: "test",
          }),
      );
      const codes = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          registries[index % 2]?.createMachineEnrollment({
            name: "desk-race",
            rule: "desk",
            ttlMinutes: 60,
            placement: {},
          }),
        ),
      );
      expect(codes.filter(Boolean)).toHaveLength(1);
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
