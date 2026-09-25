import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "../server.js";
import { testServerOptions } from "../test-support.js";
import {
  dedicatedName,
  type MachineProvisioner,
  sharedName,
} from "./machine-rules.js";

/**
 * Machine rules (ADR 0167): the directory decides who gets a machine. A
 * fake provisioner records what the reconciler asks a platform to do.
 */
let root: string;
let server: WorkServer;
let operatorSecret: string;
const platform = {
  created: [] as Array<{ name: string; class: string; code: string }>,
  destroyed: [] as string[],
  failDestroy: false,
};
const provisioner: MachineProvisioner = {
  create: async ({ name, class: machineClass, enrollment }) => {
    platform.created.push({ name, class: machineClass, code: enrollment.code });
    return { ref: `vm-${name}` };
  },
  destroy: async ({ ref }) => {
    if (platform.failDestroy) throw new Error("platform unavailable");
    platform.destroyed.push(ref ?? "");
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

    const desks = await operator("PUT", "/_work/operator/machine-rules/desk", {
      group: "eng@example.com",
      machines: "each-member",
      class: "standard-4",
    });
    expect(desks.statusCode).toBe(200);
    expect(desks.json().reconcile.created).toEqual([
      dedicatedName("desk", alice, "standard-4"),
    ]);

    const pool = await operator(
      "PUT",
      "/_work/operator/machine-rules/support",
      {
        group: "support@example.com",
        machines: { shared: 2 },
        class: "small",
        trusted: true,
      },
    );
    expect(pool.json().reconcile.created).toEqual([
      sharedName("support", "small", 1),
      sharedName("support", "small", 2),
    ]);
    expect(platform.created.map((machine) => machine.class)).toEqual([
      "standard-4",
      "small",
      "small",
    ]);

    // A machine enrolls with its code and keeps the rule's placement.
    const aliceMachine = platform.created[0];
    if (!aliceMachine) throw new Error("No machine was created");
    const enrolled = await server.app.inject({
      method: "POST",
      url: "/api/workers/enroll",
      payload: { code: aliceMachine.code },
    });
    expect(enrolled.statusCode).toBe(200);
    const listed = (await operator("GET", "/_work/operator/workers")).json();
    expect(listed.workers).toContainEqual(
      expect.objectContaining({
        name: aliceMachine.name,
        placement: {
          labels: { class: "standard-4" },
          access: { people: ["alice@example.com"], groups: [] },
          trusted: false,
        },
        machine: { rule: "desk", ref: `vm-${aliceMachine.name}` },
      }),
    );

    // Nothing to do on a second pass.
    const again = (
      await operator("POST", "/_work/operator/machine-rules/reconcile")
    ).json();
    expect(again).toMatchObject({ created: [], removed: [], failed: [] });
  });

  it("removes a disabled member's machine and a deleted rule's pool", async () => {
    const [alice] = (
      await sql<{ user_id: string }>`
        SELECT user_id FROM work_accounts
        WHERE directory_groups @> '["eng@example.com"]'::jsonb
      `.execute(server.catamorphic.core.db)
    ).rows;
    if (!alice) throw new Error("No member");
    await sql`
      UPDATE work_accounts SET disabled_at = now() WHERE user_id = ${alice.user_id}
    `.execute(server.catamorphic.core.db);
    const name = dedicatedName("desk", alice.user_id, "standard-4");
    // The platform fails once: the machine stays tracked and is retried.
    platform.failDestroy = true;
    const failed = (
      await operator("POST", "/_work/operator/machine-rules/reconcile")
    ).json();
    expect(failed.failed).toEqual([{ name, error: "platform unavailable" }]);
    platform.failDestroy = false;
    const pass = (
      await operator("POST", "/_work/operator/machine-rules/reconcile")
    ).json();
    expect(pass.removed).toEqual([name]);
    expect(platform.destroyed).toContain(`vm-${name}`);
    const listed = (await operator("GET", "/_work/operator/workers")).json();
    expect(listed.workers).toContainEqual(
      expect.objectContaining({ name, revoked: true }),
    );

    const deleted = await operator(
      "DELETE",
      "/_work/operator/machine-rules/support",
    );
    expect(deleted.json().reconcile.removed.sort()).toEqual(
      [
        sharedName("support", "small", 1),
        sharedName("support", "small", 2),
      ].sort(),
    );
  });

  it("refuses rules without a provisioner and with a bad group", async () => {
    const bad = await operator("PUT", "/_work/operator/machine-rules/x", {
      group: "not-an-email",
      machines: "each-member",
      class: "small",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("group");
  });
});
