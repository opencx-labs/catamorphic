import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkerNodesService } from "@catamorphic/core";
import { generateExecutorKeyPair } from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { testServerOptions } from "../test-support.js";
import { WORKER_PROTOCOL, WORKER_PROTOCOL_HEADER } from "./worker-protocol.js";

/** What every worker call states (ADR 0198). */
const PROTOCOL = { [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server) };

import {
  dedicatedName,
  type MachineProvisioner,
  MachineProvisioningRefusedError,
  sharedName,
} from "./machine-rules.js";
import { WorkWorkerRegistry } from "./worker-registry.js";

/**
 * Machine rules (ADRs 0167, 0205): the directory decides who gets a
 * machine. A fake provisioner records what the reconciler asks a platform
 * to do, and fails when told to.
 */
let root: string;
let server: WorkServer;
let operatorSecret: string;
const platform = {
  created: [] as Array<{ name: string; class: string; code: string }>,
  destroyed: [] as string[],
  failDestroy: false,
  /** Machines whose destruction fails while listed. */
  failDestroyFor: new Set<string>(),
  /** The next create is done but its answer lost. */
  loseCreate: false,
  /** Creates refused outright, before the platform makes anything. */
  refuseCreates: 0,
};
const provisioner: MachineProvisioner = {
  create: async ({ name, class: machineClass, enrollment }) => {
    if (platform.refuseCreates > 0) {
      platform.refuseCreates -= 1;
      throw new MachineProvisioningRefusedError("The quota is exhausted");
    }
    platform.created.push({ name, class: machineClass, code: enrollment.code });
    if (platform.loseCreate) {
      platform.loseCreate = false;
      throw new Error("The connection was reset");
    }
    return { ref: `vm-${name}` };
  },
  destroy: async ({ name, ref }) => {
    if (platform.failDestroy || platform.failDestroyFor.has(name))
      throw new Error("platform unavailable");
    platform.destroyed.push(`${name}:${ref ?? "unknown"}`);
  },
};

function operator(
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  body?: unknown,
) {
  return server.operatorApp.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${operatorSecret}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
}

/**
 * A pass now. A rule's change already started one in the background; this
 * waits for it (concurrent callers share a pass) or runs another.
 */
async function reconcile() {
  const response = await operator(
    "POST",
    "/_work/operator/machine-rules/reconcile",
  );
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function status() {
  return (await operator("GET", "/_work/operator/machine-rules")).json().status;
}

async function workers() {
  return (await operator("GET", "/_work/operator/workers")).json().workers;
}

async function enroll(code: string) {
  const enrolled = await server.app.inject({
    method: "POST",
    url: "/api/workers/enroll",
    headers: PROTOCOL,
    payload: { code, publicKey: generateExecutorKeyPair().publicKey },
  });
  expect(enrolled.statusCode).toBe(200);
}

async function member(username: string, groups: string[]): Promise<string> {
  const created = await operator("POST", "/_work/operator/users", {
    username,
    name: username,
    password: "correct horse battery staple",
    email: `${username}@example.com`,
    memberships: [],
  });
  const userId: string = created.json().user.id;
  // What a directory sweep records for the account.
  await sql`
    INSERT INTO work_accounts (user_id, directory_groups, directory_checked_at)
    VALUES (${userId}, ${JSON.stringify(groups)}::jsonb, now())
  `.execute(server.catamorphic.core.db);
  return userId;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-machine-rules-"));
  server = await createWorkServer({
    ...testServerOptions({
      dataDir: root,
      env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
    }),
    hooks: { machineProvisioner: provisioner },
  });
  operatorSecret = fs
    .readFileSync(path.join(root, "operator-secret"), "utf8")
    .trim();
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("machine rules", () => {
  it("gives each group member a machine and a team a shared pool", async () => {
    const alice = await member("alice", ["eng@example.com"]);
    await member("bob", ["support@example.com"]);

    // The rule is stored when the request answers; its pass runs after.
    const desks = await operator("PUT", "/_work/operator/machine-rules/desk", {
      group: "eng@example.com",
      machines: "each-member",
      class: "standard-4",
    });
    expect(desks.statusCode).toBe(200);
    expect(desks.json()).toEqual({
      rule: expect.objectContaining({ class: "standard-4" }),
    });
    await reconcile();
    expect(platform.created.map((machine) => machine.name)).toEqual([
      dedicatedName("desk", alice, "standard-4"),
    ]);

    await operator("PUT", "/_work/operator/machine-rules/support", {
      group: "support@example.com",
      machines: { shared: 2 },
      class: "small",
      trusted: true,
    });
    await reconcile();
    expect(platform.created.map((machine) => machine.name).slice(1)).toEqual([
      sharedName("support", "small", "support@example.com", 1),
      sharedName("support", "small", "support@example.com", 2),
    ]);
    expect(platform.created.map((machine) => machine.class)).toEqual([
      "standard-4",
      "small",
      "small",
    ]);

    // A machine enrolls with its code and keeps the rule's placement.
    const aliceMachine = platform.created[0];
    if (!aliceMachine) throw new Error("No machine was created");
    await enroll(aliceMachine.code);
    expect(await workers()).toContainEqual(
      expect.objectContaining({
        name: aliceMachine.name,
        placement: {
          labels: { class: "standard-4" },
          access: { people: ["alice@example.com"], groups: [], projects: [] },
          trusted: false,
        },
        machine: { rule: "desk", ref: `vm-${aliceMachine.name}` },
      }),
    );

    // Nothing to do on a second pass.
    expect(await reconcile()).toMatchObject({
      created: [],
      removed: [],
      failed: [],
    });
  });

  it("releases and, kept for no days, removes a disabled member's machine and a deleted rule's pool", async () => {
    const [alice] = (
      await sql<{ user_id: string }>`
        SELECT user_id FROM work_accounts
        WHERE directory_groups @> '["eng@example.com"]'::jsonb
      `.execute(server.catamorphic.core.db)
    ).rows;
    if (!alice) throw new Error("No member");
    // No retention (ADR 0205): a released machine goes in the same pass.
    await operator("PUT", "/_work/operator/machine-rules/desk", {
      group: "eng@example.com",
      machines: "each-member",
      class: "standard-4",
      retainDays: 0,
    });
    await reconcile();
    await sql`
      UPDATE work_accounts SET disabled_at = now() WHERE user_id = ${alice.user_id}
    `.execute(server.catamorphic.core.db);
    const name = dedicatedName("desk", alice.user_id, "standard-4");
    // The platform fails once: the machine stays tracked and is retried,
    // and the rule's status says what failed.
    platform.failDestroy = true;
    const failed = await reconcile();
    expect(failed.released).toEqual([name]);
    expect(failed.failed).toEqual([
      { name, error: "platform unavailable", rule: "desk" },
    ]);
    expect((await status()).desk.failure.error).toBe(
      `${name}: platform unavailable`,
    );
    expect(await workers()).toContainEqual(
      expect.objectContaining({ name, revoked: true, state: "destroying" }),
    );
    platform.failDestroy = false;
    const pass = await reconcile();
    expect(pass.removed).toEqual([name]);
    expect(platform.destroyed).toContain(`${name}:vm-${name}`);
    expect((await status()).desk.failure).toBeUndefined();
    expect(await workers()).toContainEqual(
      expect.objectContaining({ name, revoked: true, state: "revoked" }),
    );

    // A deleted rule's machines go in the pass its deletion starts.
    const deleted = await operator(
      "DELETE",
      "/_work/operator/machine-rules/support",
    );
    expect(deleted.json()).toEqual({ ok: true });
    await reconcile();
    for (const index of [1, 2]) {
      const shared = sharedName(
        "support",
        "small",
        "support@example.com",
        index,
      );
      expect(platform.destroyed).toContain(`${shared}:vm-${shared}`);
    }
  });

  it("keeps destroying a machine whose platform reference was never recorded", async () => {
    const dora = await member("dora", ["lab@example.com"]);
    const name = dedicatedName("lab", dora, "lab-vm");
    // The platform made the machine but its answer was lost: no reference,
    // and the code stays, since the machine may come up and enroll.
    platform.loseCreate = true;
    await operator("PUT", "/_work/operator/machine-rules/lab", {
      group: "lab@example.com",
      machines: "each-member",
      class: "lab-vm",
    });
    await reconcile();
    expect((await status()).lab).toMatchObject({ starting: 1 });
    const made = platform.created.find((machine) => machine.name === name);
    if (!made) throw new Error("The platform made no machine");
    await enroll(made.code);
    expect(await workers()).toContainEqual(
      expect.objectContaining({ name, machine: { rule: "lab", ref: null } }),
    );

    // The operator revokes it, and the first destruction fails: it stays
    // listed, and goes once its platform confirms it, by its name.
    expect(
      (await operator("DELETE", `/_work/operator/workers/${name}`)).statusCode,
    ).toBe(200);
    platform.failDestroyFor.add(name);
    expect((await reconcile()).failed).toContainEqual({
      name,
      error: "platform unavailable",
      rule: "lab",
    });
    expect(await workers()).toContainEqual(
      expect.objectContaining({ name, state: "destroying" }),
    );
    platform.failDestroyFor.delete(name);
    const retried = await reconcile();
    expect(retried.removed).toEqual([name]);
    expect(platform.destroyed).toContain(`${name}:unknown`);
    // The rule still wants Dora's machine: a new one is made.
    expect(retried.created).toEqual([name]);
  });

  it("withdraws the code when the platform refuses, and tries again on the next pass", async () => {
    const erin = await member("erin", ["qa@example.com"]);
    const name = dedicatedName("qa", erin, "qa-vm");
    // Refused for the pass the rule starts and the one after it (which may
    // be the same pass).
    platform.refuseCreates = 2;
    await operator("PUT", "/_work/operator/machine-rules/qa", {
      group: "qa@example.com",
      machines: "each-member",
      class: "qa-vm",
    });
    await reconcile();
    platform.refuseCreates = 0;
    // Nothing is starting: the next pass may issue a new code at once.
    expect((await status()).qa).toMatchObject({
      desired: 1,
      starting: 0,
      waiting: 1,
      failure: { error: `${name}: The quota is exhausted` },
    });
    const again = await reconcile();
    expect(again.created).toEqual([name]);
    expect((await status()).qa).toMatchObject({ starting: 1 });
    expect((await status()).qa.failure).toBeUndefined();
  });

  it("gives a shared rule's new group new machines, never the old group's", async () => {
    await member("frank", ["ops@example.com"]);
    await operator("PUT", "/_work/operator/machine-rules/ops", {
      group: "ops@example.com",
      machines: { shared: 1 },
      class: "small",
      trusted: true,
    });
    await reconcile();
    const before = sharedName("ops", "small", "ops@example.com", 1);
    const after = sharedName("ops", "small", "sre@example.com", 1);
    expect(before).not.toBe(after);
    const made = platform.created.find((machine) => machine.name === before);
    if (!made) throw new Error("No shared machine");
    await enroll(made.code);

    await operator("PUT", "/_work/operator/machine-rules/ops", {
      group: "sre@example.com",
      machines: { shared: 1 },
      class: "small",
      trusted: true,
    });
    await reconcile();
    // The old group's machine serves nobody now; the new group gets its own.
    expect(platform.created.map((machine) => machine.name)).toContain(after);
    expect(await workers()).toContainEqual(
      expect.objectContaining({ name: before, state: "released" }),
    );
  });

  it("goes on with the next machine when one fails", async () => {
    const george = await member("george", ["design@example.com"]);
    const hana = await member("hana", ["design@example.com"]);
    await operator("PUT", "/_work/operator/machine-rules/design", {
      group: "design@example.com",
      machines: "each-member",
      class: "design-vm",
      retainDays: 0,
    });
    await reconcile();
    const names = [george, hana].map((user) =>
      dedicatedName("design", user, "design-vm"),
    );
    for (const name of names) {
      const made = platform.created.find((machine) => machine.name === name);
      if (!made) throw new Error(`No machine ${name}`);
      await enroll(made.code);
    }
    const [first, second] = names;
    if (!first || !second) throw new Error("Two machines");
    // The machines keep the rule's retention (none) after it is gone.
    await reconcile();
    platform.failDestroyFor.add(first);
    await operator("DELETE", "/_work/operator/machine-rules/design");
    await reconcile();
    // The first machine's failure did not stop the second's destruction.
    expect(platform.destroyed).toContain(`${second}:vm-${second}`);
    expect(platform.destroyed).not.toContain(`${first}:vm-${first}`);
    const states = await workers();
    expect(states).toContainEqual(
      expect.objectContaining({ name: first, state: "destroying" }),
    );
    expect(states).toContainEqual(
      expect.objectContaining({ name: second, state: "revoked" }),
    );
    platform.failDestroyFor.delete(first);
    expect((await reconcile()).removed).toEqual([first]);
  });

  it("issues one code per machine and leaves a pass to the replica holding the claim", async () => {
    const db = server.catamorphic.core.db;
    const registry = new WorkWorkerRegistry({
      db,
      nodes: new WorkerNodesService(db),
      tenantId: SERVER_TENANT_ID,
      authorityId: "test",
    });
    const machine = {
      name: "desk-once",
      rule: "desk",
      ttlMinutes: 60,
      placement: {},
    };
    expect((await registry.createMachineEnrollment(machine))?.code).toMatch(
      /^wke_/,
    );
    // Its code is still waiting: the machine is being created.
    expect(await registry.createMachineEnrollment(machine)).toBeNull();
    // An operator may still hand out another code for any name.
    expect(
      (await registry.createEnrollment({ name: "desk-once" })).nodeId,
    ).toBe("worker.desk-once");
    await registry.cancelEnrollments({ name: "desk-once" });

    const carol = await member("carol", ["eng@example.com"]);
    const claim = `machine-reconciler:${SERVER_TENANT_ID}`;
    await sql`
      INSERT INTO replica_claims (name, holder, expires_at)
      VALUES (${claim}, 'another-replica', now() + interval '1 minute')
    `.execute(db);
    const skipped = await reconcile();
    expect(skipped).toMatchObject({ created: [], busy: true });
    // The other replica stopped without releasing; its claim runs out.
    await sql`
      UPDATE replica_claims SET expires_at = now() - interval '1 second'
      WHERE name = ${claim}
    `.execute(db);
    const taken = await reconcile();
    expect(taken.created).toEqual([dedicatedName("desk", carol, "standard-4")]);
  });

  it("refuses rules with a bad group", async () => {
    const bad = await operator("PUT", "/_work/operator/machine-rules/x", {
      group: "not-an-email",
      machines: "each-member",
      class: "small",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("group");
  });
});
