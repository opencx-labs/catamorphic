import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Identity } from "@catamorphic/core";
import { directoryProjectEvent } from "@catamorphic/server-sdk";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import {
  createTestDatabase,
  FakeDirectory,
  oauthAccessToken,
  testServerOptions,
} from "../test-support.js";

/**
 * Directory events start workflows (ADR 0209), end to end on network
 * Postgres: a fake directory governs local accounts, a project runs
 * automations bound to the three directory kinds, and each account
 * transition (first sign-in, a group change, a suspension, a sign-in after
 * it is restored) starts each matching workflow once with the member in
 * its input. A project that does not listen stores nothing, and a
 * workflow that does not ask for `memberships:read` cannot listen.
 */

const PASSWORD = "directory-events-test-password";
const ENG = "eng@example.com";

const AUTOMATIONS = `import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";

type Member = { id: string; email: string; name: string | null; domain: string };
type DirectoryEvent = {
  kind: string;
  externalId: string;
  payload: { member: Member; groups: string[]; added?: string[]; removed?: string[] };
};

/** @displayname Welcome */
export const welcome = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["memberships:read"],
  triggers: [trigger("directory.member-joined")],
  steps: [
    /** @displayname Note who joined */
    defineBoundary({
      run: async ({ input }: BoundaryContext<DirectoryEvent>) => ({
        email: input.payload.member.email,
        groups: input.payload.groups,
      }),
    }),
  ],
}));

/** @displayname Welcome engineers */
export const welcomeEngineers = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["memberships:read"],
  triggers: [trigger("directory.member-joined", { groups: ["${ENG}"] })],
  steps: [
    /** @displayname Note the engineer */
    defineBoundary({
      run: async ({ input }: BoundaryContext<DirectoryEvent>) => ({ email: input.payload.member.email }),
    }),
  ],
}));

/** @displayname Welcome contractors */
export const welcomeContractors = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["memberships:read"],
  triggers: [
    trigger("directory.member-joined", { where: { payload: { member: { domain: "contractor.example" } } } }),
  ],
  steps: [
    /** @displayname Note the contractor */
    defineBoundary({
      run: async ({ input }: BoundaryContext<DirectoryEvent>) => ({ email: input.payload.member.email }),
    }),
  ],
}));

/** @displayname Farewell */
export const farewell = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["memberships:read"],
  triggers: [trigger("directory.member-left")],
  steps: [
    /** @displayname Note who left */
    defineBoundary({
      run: async ({ input }: BoundaryContext<DirectoryEvent>) => ({
        email: input.payload.member.email,
        groups: input.payload.groups,
      }),
    }),
  ],
}));

/** @displayname Regroup */
export const regroup = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["memberships:read"],
  triggers: [trigger("directory.groups-changed")],
  steps: [
    /** @displayname Note the change */
    defineBoundary({
      run: async ({ input }: BoundaryContext<DirectoryEvent>) => ({
        email: input.payload.member.email,
        added: input.payload.added ?? [],
        removed: input.payload.removed ?? [],
      }),
    }),
  ],
}));
`;

const CARELESS = `import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";

/** @displayname Watch people */
export const watchPeople = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("directory.member-joined")],
  steps: [
    /** @displayname Note it */
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ id: string }>) => ({ id: input.id }),
    }),
  ],
}));
`;

const WORKFLOWS = [
  "welcome",
  "welcomeEngineers",
  "welcomeContractors",
  "farewell",
  "regroup",
];

let root: string;
let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let server: WorkServer;
const directory = new FakeDirectory();
const setup: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "work-setup-agent",
};
let listening: string;
let quiet: string;

function projectFiles(workflows: string): Record<string, string> {
  return {
    ".work/project.json": JSON.stringify({
      environments: { default: { workloads: ["workflow"] } },
      defaultEnvironment: "default",
    }),
    ".work/package.json": JSON.stringify({
      name: "people",
      private: true,
      workspaces: ["workflows"],
    }),
    ".work/workflows/package.json": JSON.stringify({
      name: "@project/workflows",
      private: true,
      type: "module",
      dependencies: { "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION },
    }),
    ".work/workflows/src/people.ts": workflows,
  };
}

async function deployProject(name: string, workflows: string) {
  const core = server.catamorphic.core;
  const project = await core.projects.create(setup, { name });
  const deployed = await core.deployment.deploy(
    SERVER_TENANT_ID,
    project.id,
    setup.externalUserId,
    { message: "People automations", files: projectFiles(workflows) },
  );
  expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
  return project.id;
}

async function enable(projectId: string, workflowName: string) {
  const core = server.catamorphic.core;
  const request = {
    identity: setup,
    projectId,
    workflowName,
    owner: { type: "project" as const },
  };
  const preview = await core.workflowEnablements.preview(request);
  expect(preview.permissions).toEqual(["memberships:read"]);
  await core.workflowEnablements.create({
    ...request,
    consentDigest: preview.consentDigest,
  });
}

async function member(username: string, email: string) {
  const user = await server.workAuth.createLocalUser({
    username,
    name: username,
    password: PASSWORD,
    email,
  });
  return user.id;
}

/** A first (or renewed) sign-in: the OAuth code exchange a client runs. */
function signIn(username: string) {
  return oauthAccessToken({ app: server.app, username, password: PASSWORD });
}

async function events(projectId: string) {
  return server.catamorphic.core.db
    .selectFrom("project_events")
    .select(["kind", "external_id", "payload"])
    .where("project_id", "=", projectId)
    .where("source", "=", "directory")
    .orderBy("sequence")
    .execute();
}

/** Completed runs of one workflow, oldest first, by their results. */
async function results(workflowName: string) {
  const runs = await server.catamorphic.core.db
    .selectFrom("workflow_runs")
    .select(["status", "result", "error", "input"])
    .where("project_id", "=", listening)
    .where("workflow_name", "=", workflowName)
    .orderBy("created_at")
    .execute();
  for (const run of runs)
    if (run.status === "failed")
      throw new Error(`${workflowName} failed: ${run.error}`);
  return runs;
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      const db = server.catamorphic.core.db;
      const state = await db
        .selectFrom("project_event_deliveries")
        .select(["status", "error", "run_ids"])
        .execute();
      throw new Error(
        `Timed out waiting for ${what}: ${JSON.stringify(state)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Wait until every delivery so far is settled, then read the runs. */
async function settled(workflowName: string, count: number) {
  return waitFor(`${count} completed ${workflowName} run(s)`, async () => {
    const pending = await server.catamorphic.core.db
      .selectFrom("project_event_deliveries")
      .select("event_id")
      .where("status", "!=", "completed")
      .execute();
    const runs = await results(workflowName);
    return pending.length === 0 &&
      runs.length === count &&
      runs.every((run) => run.status === "completed")
      ? runs.map((run) => run.result)
      : undefined;
  });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-directory-events-"));
  database = await createTestDatabase("work_directory_events");
  server = await createWorkServer({
    ...testServerOptions({
      dataDir: path.join(root, "server"),
      env: {
        DATABASE_URL: database.url,
        WORK_SECRET: "directory-events-secret-with-at-least-32-characters",
        WORK_OPERATOR_SECRET:
          "directory-events-operator-secret-of-32-characters",
        WORK_VAULT_KEY: Buffer.alloc(32, 9).toString("base64"),
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        WORK_FAKE_AGENT: "1",
        WORK_AUTH_RATE_LIMIT: "off",
        PATH: process.env.PATH,
      },
    }),
    hooks: { directories: [directory] },
  });
  listening = await deployProject("People", AUTOMATIONS);
  for (const workflowName of WORKFLOWS) await enable(listening, workflowName);
  // The same automations, deployed but never turned on.
  quiet = await deployProject("Quiet", AUTOMATIONS);
}, 180_000);

afterAll(async () => {
  await server?.shutdown();
  await database?.drop();
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
});

describe.skipIf(!process.env.DATABASE_URL)(
  "directory events (ADR 0209)",
  () => {
    let ada: string;
    let bob: string;

    it("a first sign-in starts the workflows that select the new member, in listening projects only", async () => {
      ada = await member("ada", "Ada@Example.com");
      bob = await member("bob", "bob@contractor.example");
      directory.accounts.set(ada, { active: true, groups: [ENG] });

      // Created but not yet signed in: nobody has joined.
      expect(await events(listening)).toEqual([]);
      await signIn("ada");
      await signIn("bob");

      expect(await events(listening)).toEqual([
        {
          kind: "directory.member-joined",
          external_id: `directory.member-joined:${ada}:1`,
          payload: {
            member: {
              id: ada,
              email: "ada@example.com",
              name: "ada",
              domain: "example.com",
            },
            groups: [ENG],
          },
        },
        {
          kind: "directory.member-joined",
          external_id: `directory.member-joined:${bob}:1`,
          payload: {
            member: {
              id: bob,
              email: "bob@contractor.example",
              name: "bob",
              domain: "contractor.example",
            },
            groups: [],
          },
        },
      ]);
      expect(await events(quiet)).toEqual([]);

      expect(await settled("welcome", 2)).toEqual([
        { email: "ada@example.com", groups: [ENG] },
        { email: "bob@contractor.example", groups: [] },
      ]);
      // A group in a binding's config is asked about, so it can select.
      expect(await settled("welcomeEngineers", 1)).toEqual([
        { email: "ada@example.com" },
      ]);
      expect(await settled("welcomeContractors", 1)).toEqual([
        { email: "bob@contractor.example" },
      ]);
      const [run] = await results("welcome");
      expect(run?.input).toMatchObject({
        source: "directory",
        kind: "directory.member-joined",
        externalId: `directory.member-joined:${ada}:1`,
        payload: { member: { id: ada } },
      });

      // Signing in again joins nobody again.
      await signIn("ada");
      expect(await events(listening)).toHaveLength(2);
    });

    it("a group change starts the workflows bound to it once, with what changed", async () => {
      directory.accounts.set(bob, { active: true, groups: [ENG] });
      await server.accounts.refreshStanding({ userId: bob, force: true });
      // The same answer again is no change.
      await server.accounts.refreshStanding({ userId: bob, force: true });

      const changes = (await events(listening)).filter(
        (event) => event.kind === "directory.groups-changed",
      );
      expect(changes).toEqual([
        {
          kind: "directory.groups-changed",
          external_id: `directory.groups-changed:${bob}:2`,
          payload: {
            member: expect.objectContaining({ id: bob }),
            groups: [ENG],
            added: [ENG],
            removed: [],
          },
        },
      ]);
      expect(await settled("regroup", 1)).toEqual([
        { email: "bob@contractor.example", added: [ENG], removed: [] },
      ]);
    });

    it("a suspension starts the departure workflows once, and a restored account joins again", async () => {
      directory.accounts.set(ada, { active: false, reason: "suspended" });
      const sweep = await server.accounts.sweep();
      expect(sweep.disabled).toBe(1);
      // Disabling again, or another sweep, is no second departure.
      await server.accounts.disable({ userId: ada, reason: "suspended" });
      await server.accounts.sweep();

      const departures = (await events(listening)).filter(
        (event) => event.kind === "directory.member-left",
      );
      expect(departures).toEqual([
        {
          kind: "directory.member-left",
          external_id: `directory.member-left:${ada}:2`,
          payload: {
            member: expect.objectContaining({ email: "ada@example.com" }),
            groups: [ENG],
          },
        },
      ]);
      expect(await settled("farewell", 1)).toEqual([
        { email: "ada@example.com", groups: [ENG] },
      ]);

      directory.accounts.set(ada, { active: true, groups: [] });
      await signIn("ada");
      expect(await events(listening)).toContainEqual(
        expect.objectContaining({
          kind: "directory.member-joined",
          external_id: `directory.member-joined:${ada}:3`,
        }),
      );
      expect(await settled("welcome", 3)).toContainEqual({
        email: "ada@example.com",
        groups: [],
      });
    });

    it("appending a transition again stores it once", async () => {
      const before = await events(listening);
      const replay = directoryProjectEvent({
        kind: "directory.member-left",
        member: { id: ada, email: "ada@example.com", name: "ada" },
        groups: [ENG],
        occurredAt: new Date(),
        revision: 2,
      });
      const { events: appended } =
        await server.catamorphic.core.projectEvents.appendToSubscribers({
          tenantId: SERVER_TENANT_ID,
          ...replay,
        });
      expect(appended.map((event) => event.projectId)).toEqual([listening]);
      expect(await events(listening)).toEqual(before);
      expect(await settled("farewell", 1)).toHaveLength(1);
    });

    it("refuses a workflow that listens without memberships:read", async () => {
      const careless = await deployProject("Careless", CARELESS);
      await expect(
        server.catamorphic.core.workflowEnablements.preview({
          identity: setup,
          projectId: careless,
          workflowName: "watchPeople",
          owner: { type: "project" },
        }),
      ).rejects.toThrow(
        `Workflow 'watchPeople' trigger 'directory.member-joined': 'directory.member-joined' events need memberships:read: declare permissions: ["memberships:read"] in the workflow`,
      );
    });
  },
);
