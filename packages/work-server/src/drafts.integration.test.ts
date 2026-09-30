import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "./server.js";
import { oauthAccessToken, testServerOptions } from "./test-support.js";

const ROLE = {
  version: 1,
  name: "Builder",
  permissions: ["*"],
  agents: ["*"],
  workflows: ["*"],
  apps: ["*"],
  environments: ["default"],
};

const GREET = `import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";

/** @displayname Greet */
export const greet = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ai.tool-call", { description: "Greet someone by name" })],
  steps: [
    /** @displayname Say hello */
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ name: string }>) => ({
        greeting: \`Hello, \${input.name}\`,
      }),
    }),
  ],
}));
`;

/**
 * Issue #148's done-when (ADR 0191): with two replicas and every request
 * routed to the other one, a member writes, checks, and deploys a workflow
 * over the project MCP and each step sees the one before. Both replicas
 * are then replaced by fresh ones with empty disks mid-loop, and nothing
 * the member drafted is lost.
 */
it.skipIf(!process.env.DATABASE_URL)(
  "a member's draft follows every request across replicas and restarts",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-drafts-"));
    // Its own database: a deployment's replicas share one origin and
    // secret, which other suites on this server do not.
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    const database = `work_drafts_${randomBytes(4).toString("hex")}`;
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
    databaseUrl.pathname = `/${database}`;
    const env = {
      DATABASE_URL: databaseUrl.toString(),
      WORK_SECRET: "drafts-test-secret-with-at-least-32-characters",
      WORK_VAULT_KEY: Buffer.alloc(32, 5).toString("base64"),
      WORK_OPERATOR_SECRET: "drafts-test-operator-secret-with-32-characters",
      WORK_CONTROL_PLANE_WORKLOADS: "workflow",
      WORK_FAKE_AGENT: "1",
      PATH: process.env.PATH,
    };
    let generation = 0;
    const boot = (name: string) =>
      createWorkServer(
        testServerOptions({
          // A fresh disk every boot: a replica keeps nothing a member needs.
          dataDir: path.join(dir, `${name}-${generation}`),
          publicBases: ["https://drafts.example.test"],
          env: { ...env, WORK_MACHINE_NAME: `${name}-${generation}` },
        }),
      );
    let replicas: WorkServer[] = [];
    try {
      replicas = [await boot("a"), await boot("b")];
      const [first] = replicas;
      if (!first) throw new Error("Replica a must boot");
      const operator = (url: string, body: unknown) =>
        first.operatorApp.inject({
          method: "POST",
          url,
          headers: {
            authorization: `Bearer ${env.WORK_OPERATOR_SECRET}`,
            "content-type": "application/json",
          },
          payload: JSON.stringify(body),
        });
      const project = await operator("/_work/operator/projects", {
        name: "drafts",
        roles: [{ slug: "builder", definition: ROLE }],
        admission: {
          mode: "invitation_only",
          defaultRole: "builder",
          approvedDomains: [],
        },
      });
      expect(project.statusCode).toBe(201);
      const projectId: string = project.json().project.id;
      const user = await operator("/_work/operator/users", {
        username: "builder",
        name: "Builder",
        password: "correct horse battery staple",
        memberships: [{ projectId, roles: ["builder"] }],
      });
      expect(user.statusCode).toBe(201);
      const token = await oauthAccessToken({
        app: first.app,
        username: "builder",
        password: "correct horse battery staple",
      });

      let request = 0;
      const served: number[] = [];
      const tool = async (name: string, args: Record<string, unknown> = {}) => {
        // Every call goes to the replica the previous one did not use.
        const index = request++ % replicas.length;
        served.push(index);
        const replica = replicas[index];
        if (!replica) throw new Error("No replica");
        const response = await replica.app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/mcp`,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          payload: JSON.stringify({
            jsonrpc: "2.0",
            id: request,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        expect(response.statusCode).toBe(200);
        const result = response.json().result;
        const text: string = result.content[0].text;
        if (result.isError) throw new Error(`${name}: ${text}`);
        return JSON.parse(text);
      };
      const restartBoth = async () => {
        await Promise.all(replicas.map((replica) => replica.shutdown()));
        generation++;
        replicas = [await boot("a"), await boot("b")];
      };

      await tool("program_write", {
        changes: [{ path: ".work/workflows/greet.ts", content: GREET }],
      });
      const draft = await tool("program_files");
      expect(draft.changed).toContain(".work/workflows/greet.ts");
      expect(
        (await tool("program_files", { path: ".work/workflows/greet.ts" }))
          .content,
      ).toBe(GREET);

      await restartBoth();
      expect((await tool("program_files")).changed).toContain(
        ".work/workflows/greet.ts",
      );
      await tool("program_write", {
        changes: [
          {
            path: ".work/workflows/greet.ts",
            content: GREET.replace("Hello", "Hi"),
          },
        ],
      });
      expect((await tool("program_check")).ok).toBe(true);

      await restartBoth();
      const deployed = await tool("program_deploy", { message: "Add greet" });
      expect(deployed.status).toBe("deployed");
      const overview = await tool("project_overview");
      expect(
        overview.workflows.map((entry: { name: string }) => entry.name),
      ).toContain("greet");
      expect(overview.draft.changed).toEqual([]);
      const published = await tool("program_files", {
        path: ".work/workflows/greet.ts",
      });
      expect(published.content).toContain("Hi, ");
      expect((await tool("program_deploy", { message: "Again" })).status).toBe(
        "nothing-to-deploy",
      );
      // Consecutive steps really alternated between the two replicas.
      for (let i = 1; i < served.length; i++)
        expect(served[i]).not.toBe(served[i - 1]);
    } finally {
      await Promise.allSettled(replicas.map((replica) => replica.shutdown()));
      // Closed pools finish hanging up on their own; forcing them off first
      // would surface as errors in clients that are already ending.
      for (let wait = 0; wait < 50; wait++) {
        const { rows } = await admin.query(
          "SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = $1",
          [database],
        );
        if (rows[0]?.open === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  180_000,
);
