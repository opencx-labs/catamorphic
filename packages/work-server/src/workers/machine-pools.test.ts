import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Identity, WorkerNodesService } from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import {
  HetznerCloudClient,
  HetznerCloudMachines,
  MACHINE_LABEL,
} from "@catamorphic/hetzner";
import { FakeHetznerCloud } from "@catamorphic/hetzner/testing";
import {
  generateExecutorKeyPair,
  machineSignInHome,
} from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { say, testServerOptions } from "../test-support.js";
import { installTarget } from "./install-script.js";
import type { MachineClass } from "./machine-classes.js";
import { dedicatedName, MachineReconciler } from "./machine-rules.js";
import { signInRoot } from "./sign-ins.js";
import { WORKER_PROTOCOL, WORKER_PROTOCOL_HEADER } from "./worker-protocol.js";
import { WorkWorkerRegistry } from "./worker-registry.js";
import { startWorkWorker } from "./worker-runtime.js";

/**
 * Machine classes, pools and retention (ADR 0205). The test runs its own
 * reconcilers against the server's database with a fake Hetzner Cloud;
 * pooled machines are real workers. Retention runs on the database's
 * clock, so time passes by moving a release back in the database.
 */
const PUBLIC = "https://brain.example.test";
const TOKEN = "hcloud-test-token";
const ENG = "eng@example.com";
const LAB = "lab@example.com";
const PROTOCOL = { [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server) };
const IMAGE = "ghcr.io/acme/work-server:test";

const classes: Record<string, MachineClass> = {
  cloud: {
    platform: "hetzner-cloud",
    serverType: "cpx31",
    location: "fsn1",
    image: "ubuntu-24.04",
    snapshot: true,
  },
  office: { platform: "pool" },
};

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

let root: string;
let server: WorkServer;
let base: string;
let operatorSecret: string;
let authorityId: string;
let db: Kysely<DB>;
let nodes: WorkerNodesService;
let registry: WorkWorkerRegistry;
let projectId: string;
const cloud = new FakeHetznerCloud({ token: TOKEN });
const workers: Array<Awaited<ReturnType<typeof startWorkWorker>>> = [];
const workerDirs: Record<string, string> = {};

const hetznerWith = (fetch: typeof cloud.fetch) =>
  new HetznerCloudMachines({
    client: new HetznerCloudClient({
      token: TOKEN,
      fetch,
      sleep: async () => {},
    }),
  });
const reconcilerWith = (
  options: { fetch?: typeof cloud.fetch; workerImage?: string } = {},
) =>
  new MachineReconciler({
    db,
    tenantId: SERVER_TENANT_ID,
    workers: registry,
    classes,
    hetzner: hetznerWith(options.fetch ?? cloud.fetch),
    install: installTarget({
      publicBase: PUBLIC,
      ...("workerImage" in options
        ? options.workerImage
          ? { workerImage: options.workerImage }
          : {}
        : { workerImage: IMAGE }),
    }),
    controlPlaneUrl: PUBLIC,
    emailOf: async (userId) =>
      (await server.workAuth.findUserById({ userId }))?.email?.toLowerCase(),
  });
let reconciler: MachineReconciler;

/** Time passes for a released machine: its release moves back. */
const age = async (name: string, days: number) => {
  await sql`
    UPDATE work_workers
    SET released_at = released_at - make_interval(secs => ${days * 86_400})
    WHERE name = ${name} AND released_at IS NOT NULL
  `.execute(db);
};

const operator = (method: "POST", url: string, body: unknown) =>
  server.operatorApp.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${operatorSecret}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
/** What a directory sweep records for the account. */
const setGroups = async (userId: string, groups: string[]) => {
  await sql`
    INSERT INTO work_accounts (user_id, directory_groups, directory_checked_at)
    VALUES (${userId}, ${JSON.stringify(groups)}::jsonb, now())
    ON CONFLICT (user_id) DO UPDATE SET directory_groups = EXCLUDED.directory_groups
  `.execute(db);
};
const member = async (username: string, groups: string[]) => {
  const created = await operator("POST", "/_work/operator/users", {
    username,
    name: username,
    password: "correct horse battery staple",
    email: `${username}@example.com`,
    memberships: [],
  });
  expect(created.statusCode).toBe(201);
  const userId: string = created.json().user.id;
  await setGroups(userId, groups);
  return { userId, email: `${username}@example.com` };
};
const pooledWorker = async (name: string) => {
  const enrollment = await registry.createEnrollment({
    name,
    pool: true,
    placement: { labels: { class: "office" } },
  });
  const dataDir = path.join(root, name);
  workerDirs[name] = dataDir;
  workers.push(
    await startWorkWorker({
      controlPlaneUrl: base,
      dataDir,
      enrollmentCode: enrollment.code,
      execution: executionSettingsFromEnv({
        PATH: process.env.PATH,
        WORK_SANDBOX: "local-process",
        WORK_MAX_WORKSPACES: "2",
      }),
    }),
  );
  await waitFor(() => registry.connected({ name }), `${name} to connect`);
};
const stateOf = async (name: string) =>
  (await registry.list()).find((worker) => worker.name === name);

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-machine-pools-"));
  const dataDir = path.join(root, "control-plane");
  server = await createWorkServer(
    testServerOptions({
      dataDir,
      publicBases: [PUBLIC],
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_SANDBOX: "local-process",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        WORK_AUTH_RATE_LIMIT: "off",
        PATH: process.env.PATH,
      },
    }),
  );
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  base = `http://127.0.0.1:${address.port}`;
  operatorSecret = fs
    .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
    .trim();
  authorityId = fs.readFileSync(path.join(dataDir, "host-id"), "utf8").trim();
  db = server.catamorphic.core.db;
  nodes = new WorkerNodesService(db);
  registry = new WorkWorkerRegistry({
    db,
    nodes,
    tenantId: SERVER_TENANT_ID,
    authorityId,
  });
  reconciler = reconcilerWith();
  const owner: Identity = {
    tenantId: SERVER_TENANT_ID,
    externalUserId: "machine-pools-test",
  };
  const project = await server.catamorphic.core.projects.create(owner, {
    name: "Pooled machines",
  });
  projectId = project.id;
  await server.catamorphic.core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    owner.externalUserId,
    {
      message: "Run agents in the office pool",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            office: {
              pool: { class: "office" },
              strict: true,
              workloads: ["agent"],
            },
          },
          defaultEnvironment: "office",
        }),
      },
    },
  );
}, 120_000);

afterAll(async () => {
  for (const worker of workers) await worker.stop().catch(() => undefined);
  await server?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

describe("machine classes, pools and retention (ADR 0205)", () => {
  it("issues no code while machines cannot install, and withdraws one Hetzner refuses", async () => {
    const ivy = await member("ivy", ["support@example.com"]);
    const name = dedicatedName("help", ivy.userId, "cloud");
    const blind = reconcilerWith({ workerImage: undefined });
    await blind.setRule({
      name: "help",
      rule: {
        group: "support@example.com",
        machines: "each-member",
        class: "cloud",
      },
    });
    const unavailable = await blind.reconcile();
    expect(unavailable.failed).toContainEqual({
      name,
      error: expect.stringContaining("WORK_WORKER_IMAGE"),
      rule: "help",
    });
    expect(cloud.serverNamed(name)).toBeUndefined();
    expect(
      (await registry.machines()).map((machine) => machine.name),
    ).not.toContain(name);
    expect((await blind.status()).help).toMatchObject({
      starting: 0,
      waiting: 1,
      failure: { error: expect.stringContaining("WORK_WORKER_IMAGE") },
    });

    // Hetzner refuses the server (a 4xx): nothing was made, so the code
    // goes and the next pass tries again.
    cloud.fail({
      method: "POST",
      path: "/servers",
      status: 422,
      code: "invalid_input",
      message: "unsupported location for server type",
    });
    const refused = await reconciler.reconcile();
    expect(refused.failed).toContainEqual({
      name,
      error: expect.stringContaining("unsupported location"),
      rule: "help",
    });
    expect((await reconciler.status()).help).toMatchObject({
      starting: 0,
      waiting: 1,
    });
    expect((await reconciler.reconcile()).created).toEqual([name]);
    expect((await reconciler.status()).help).toMatchObject({ starting: 1 });
    expect((await reconciler.status()).help?.failure).toBeUndefined();
    await reconciler.deleteRule("help");
    expect((await reconciler.reconcile()).removed).toEqual([name]);
  });

  it("creates a Hetzner machine once, keeps it while released, then snapshots and destroys it over several passes", async () => {
    const ada = await member("ada", [ENG]);
    const grace = await member("grace", []);
    await reconciler.setRule({
      name: "desk",
      rule: {
        group: ENG,
        machines: "each-member",
        class: "cloud",
        retainDays: 2,
      },
    });
    const adaMachine = dedicatedName("desk", ada.userId, "cloud");
    const first = await reconciler.reconcile();
    expect(first).toMatchObject({ created: [adaMachine], failed: [] });
    const adaServer = cloud.serverNamed(adaMachine);
    expect(adaServer).toMatchObject({
      server_type: "cpx31",
      location: "fsn1",
      image: "ubuntu-24.04",
      labels: {
        [MACHINE_LABEL]: adaMachine,
        "work-rule": "desk",
        "work-class": "cloud",
      },
    });
    // Cloud-init carries the install script and this machine's code.
    expect(adaServer?.user_data.startsWith("#cloud-config\n")).toBe(true);
    const code = adaServer?.user_data.match(/"--code", "(wke_[^"]+)"/)?.[1];
    expect(code).toBeDefined();

    // A server a lost answer already created is this machine: one server.
    await setGroups(grace.userId, [ENG]);
    const graceMachine = dedicatedName("desk", grace.userId, "cloud");
    const lost = await hetznerWith(cloud.fetch).create({
      name: graceMachine,
      serverType: "cpx31",
      location: "fsn1",
      image: "ubuntu-24.04",
      userData: "#cloud-config\n",
    });
    const second = await reconciler.reconcile();
    expect(second.created).toEqual([graceMachine]);
    expect(
      [...cloud.servers.values()].filter(
        (server) => server.name === graceMachine,
      ),
    ).toHaveLength(1);
    expect(
      (await registry.machines()).find(
        (machine) => machine.name === graceMachine,
      ),
    ).toMatchObject({ state: "pending", ref: `hcloud:${lost.ref}` });

    // Ada's machine enrolls with the code it booted with.
    const enrolled = await server.app.inject({
      method: "POST",
      url: "/api/workers/enroll",
      headers: PROTOCOL,
      payload: { code, publicKey: generateExecutorKeyPair().publicKey },
    });
    expect(enrolled.statusCode).toBe(200);
    expect(await reconciler.reconcile()).toMatchObject({
      created: [],
      released: [],
      removed: [],
    });
    expect((await reconciler.status()).desk).toMatchObject({
      platform: "hetzner-cloud",
      desired: 2,
      ready: 1,
      starting: 1,
      waiting: 0,
    });

    // Ada leaves the group: her machine serves nobody at once, kept.
    const nodeId = `worker.${adaMachine}`;
    await setGroups(ada.userId, []);
    const left = await reconciler.reconcile();
    expect(left).toMatchObject({ released: [adaMachine], removed: [] });
    expect((await registry.placements()).has(nodeId)).toBe(false);
    expect((await registry.placement(nodeId)).access).toEqual({
      nobody: true,
    });
    expect(await stateOf(adaMachine)).toMatchObject({
      state: "released",
      released: { retainDays: 2 },
    });
    expect(cloud.serverNamed(adaMachine)).toBeDefined();

    // A day later she is back: the machine is hers again.
    await age(adaMachine, 1);
    await setGroups(ada.userId, [ENG]);
    expect((await reconciler.reconcile()).assigned).toEqual([adaMachine]);
    expect((await registry.placements()).get(nodeId)?.access).toEqual({
      people: [ada.email],
      groups: [],
      projects: [],
    });

    // She leaves again. A day on it is still kept; past two days a pass
    // starts its snapshot and returns, and a later pass, once the snapshot
    // is written, destroys it.
    await setGroups(ada.userId, []);
    expect((await reconciler.reconcile()).released).toEqual([adaMachine]);
    await age(adaMachine, 1);
    expect((await reconciler.reconcile()).removed).toEqual([]);
    await age(adaMachine, 1.5);
    const snapshotting = await reconciler.reconcile();
    expect(snapshotting).toMatchObject({
      removed: [],
      destroying: [adaMachine],
      failed: [],
    });
    expect(await stateOf(adaMachine)).toMatchObject({ state: "destroying" });
    expect(cloud.serverNamed(adaMachine)).toBeDefined();
    cloud.advance();
    const gone = await reconciler.reconcile();
    expect(gone).toMatchObject({ removed: [adaMachine], failed: [] });
    expect(cloud.serverNamed(adaMachine)).toBeUndefined();
    const snapshots = [...cloud.images.values()].filter(
      (image) => image.labels[MACHINE_LABEL] === adaMachine,
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      status: "available",
      labels: { "work-rule": "desk" },
    });
    expect(await stateOf(adaMachine)).toMatchObject({
      revoked: true,
      state: "revoked",
    });

    await reconciler.deleteRule("desk");
    // Grace's machine never enrolled: it goes at once with its rule.
    expect((await reconciler.reconcile()).removed).toEqual([graceMachine]);
  }, 120_000);

  it("assigns free pooled machines, waits when none is free, and resets released ones through their workers", async () => {
    await pooledWorker("office-1");
    await pooledWorker("office-2");
    // A pooled machine nobody holds takes no work.
    expect(await stateOf("office-1")).toMatchObject({
      pool: true,
      state: "free",
      placement: { labels: { class: "office" }, access: { nobody: true } },
    });
    const people = [
      await member("carol", [LAB]),
      await member("dave", [LAB]),
      await member("erin", [LAB]),
    ];
    await reconciler.setRule({
      name: "lab",
      rule: {
        group: LAB,
        machines: "each-member",
        class: "office",
        retainDays: 1,
      },
    });
    const first = await reconciler.reconcile();
    expect(first.assigned.sort()).toEqual(["office-1", "office-2"]);
    expect((await reconciler.status()).lab).toMatchObject({
      platform: "pool",
      desired: 3,
      ready: 2,
      waiting: 1,
      released: 0,
    });
    const held = (await registry.pooledMachines()).filter(
      (machine) => machine.rule === "lab",
    );
    const [machine, other] = held;
    if (!machine || !other) throw new Error("Both machines are held");
    const holder = people.find((person) => person.userId === machine.member);
    const otherHolder = people.find((person) => person.userId === other.member);
    const waiting = people.find(
      (person) => !held.some((candidate) => candidate.member === person.userId),
    );
    if (!holder || !otherHolder || !waiting) throw new Error("No holders");

    // The holder's chat runs on their machine.
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    const identity: Identity = {
      tenantId: SERVER_TENANT_ID,
      externalUserId: holder.userId,
    };
    const session = await sessions.create(identity, projectId, {
      environment: "office",
    });
    const dir = workerDirs[machine.name] ?? "";
    const where = () =>
      say({
        sessions,
        identity,
        projectId,
        sessionId: session.id,
        text: "execution-location",
      }).then(
        (reply) => reply.content,
        (error: unknown) => String(error),
      );
    expect(await where()).toContain(path.join(dir, "sandboxes"));
    // Their own sign-in, and a sandbox nobody uses, on that machine.
    const home = machineSignInHome({
      root: signInRoot(dir),
      harness: "claude-code",
      member: holder.userId,
    });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, ".credentials.json"), "{}");
    const offer = (
      await nodes.list({ tenantId: SERVER_TENANT_ID, authorityId })
    ).find((node) => node.id === machine.nodeId)?.remote;
    if (!offer) throw new Error("The machine offers nothing");
    const orphan = await nodes
      .remoteProvider({ nodeId: machine.nodeId, offer, label: "The worker" })
      .createSandbox({});

    // They leave the group: the machine serves nobody at once and is kept
    // for them, so the waiting member still waits.
    await setGroups(holder.userId, []);
    const left = await reconciler.reconcile();
    expect(left).toMatchObject({ released: [machine.name], assigned: [] });
    expect((await registry.placements()).has(machine.nodeId)).toBe(false);
    expect((await reconciler.status()).lab).toMatchObject({
      desired: 2,
      ready: 1,
      released: 1,
      waiting: 1,
    });
    // Their chat re-checks access on its next turn: not there any more.
    expect(await where()).not.toContain(path.join(dir, "sandboxes"));

    // Their retention ends. The reset waits while their chat holds its
    // workspace, then the worker wipes the machine, and the waiting
    // member gets it in the same pass.
    await age(machine.name, 1.5);
    const holding = await reconciler.reconcile();
    expect(holding.reset).toEqual([]);
    expect(await stateOf(machine.name)).toMatchObject({ state: "resetting" });
    await sessions.close(identity, projectId, session.id);
    const reset = await reconciler.reconcile();
    expect(reset).toMatchObject({
      reset: [machine.name],
      assigned: [machine.name],
      failed: [],
    });
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(path.join(dir, "sandboxes", orphan.providerId))).toBe(
      false,
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "sandboxes.json"), "utf8")),
    ).toEqual([]);
    const handed = (await registry.pooledMachines()).find(
      (candidate) => candidate.name === machine.name,
    );
    expect(handed).toMatchObject({
      rule: "lab",
      member: waiting.userId,
      releasedForMs: null,
    });
    expect(handed?.placement.access).toEqual({
      people: [waiting.email],
      groups: [],
      projects: [],
    });

    // The other holder leaves while their machine's worker is away: its
    // reset waits until it is back, then it is free in the pool.
    await setGroups(otherHolder.userId, []);
    expect((await reconciler.reconcile()).released).toEqual([other.name]);
    await nodes.setEnabled({
      tenantId: SERVER_TENANT_ID,
      authorityId,
      nodeId: other.nodeId,
      enabled: false,
    });
    await age(other.name, 1.5);
    expect((await reconciler.reconcile()).reset).toEqual([]);
    expect(await stateOf(other.name)).toMatchObject({ state: "resetting" });
    await nodes.setEnabled({
      tenantId: SERVER_TENANT_ID,
      authorityId,
      nodeId: other.nodeId,
      enabled: true,
    });
    await waitFor(
      () => registry.connected({ name: other.name }),
      `${other.name} to reconnect`,
    );
    expect((await reconciler.reconcile()).reset).toEqual([other.name]);
    expect(await stateOf(other.name)).toMatchObject({
      state: "free",
      released: null,
      machine: null,
      placement: { access: { nobody: true } },
    });
    await reconciler.deleteRule("lab");

    // A shared pooled machine belongs to its rule's group: when the rule's
    // group changes, it is released, never handed to the new group.
    await reconciler.setRule({
      name: "team",
      rule: {
        group: "team-a@example.com",
        machines: { shared: 1 },
        class: "office",
        trusted: true,
      },
    });
    expect((await reconciler.reconcile()).assigned).toEqual([other.name]);
    expect((await stateOf(other.name))?.placement.access).toEqual({
      people: [],
      groups: ["team-a@example.com"],
      projects: [],
    });
    await reconciler.setRule({
      name: "team",
      rule: {
        group: "team-b@example.com",
        machines: { shared: 1 },
        class: "office",
        trusted: true,
      },
    });
    const changed = await reconciler.reconcile();
    expect(changed.released).toContain(other.name);
    expect(changed.assigned).not.toContain(other.name);
    expect(await stateOf(other.name)).toMatchObject({ state: "released" });
    await reconciler.deleteRule("team");
  }, 180_000);

  it("runs one pass at a time across reconcilers, under the tenant's claim", async () => {
    const hal = await member("hal", ["ops@example.com"]);
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const inCreate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Server creation waits until the test lets it finish.
    const gated: typeof cloud.fetch = async (input, init) => {
      if (
        init?.method === "POST" &&
        new URL(input).pathname.endsWith("/servers")
      ) {
        entered();
        await released;
      }
      return cloud.fetch(input, init);
    };
    const one = reconcilerWith({ fetch: gated });
    const two = reconcilerWith({ fetch: gated });
    await one.setRule({
      name: "ops",
      rule: {
        group: "ops@example.com",
        machines: "each-member",
        class: "cloud",
      },
    });
    const running = one.reconcile();
    await inCreate;
    expect(await two.reconcile()).toMatchObject({ busy: true, created: [] });
    release();
    expect((await running).created).toEqual([
      dedicatedName("ops", hal.userId, "cloud"),
    ]);
    // Once it is done the other may run, and finds nothing to do.
    expect(await two.reconcile()).toMatchObject({ created: [], failed: [] });
    expect((await two.reconcile()).busy).toBeUndefined();
    await one.deleteRule("ops");
    await one.reconcile();
  }, 60_000);
});
