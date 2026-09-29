import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Identity } from "@catamorphic/core";
import pg from "pg";
import { expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { testServerOptions } from "../test-support.js";
import { startWorkWorker } from "./worker-runtime.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A load balancer in front of the replicas that sends each request to a
 * random live one, answers some with a 502 of its own, and loses some
 * responses after the replica acted on them.
 */
function flakyBalancer(replicas: Map<string, string>) {
  const stats = {
    connects: 0,
    /** The replica that took the worker's lease. */
    holder: "",
    badGateways: 0,
    /** Calls sent to a replica that had stopped. */
    unreachable: 0,
    lostResponses: 0,
    lostJobs: 0,
  };
  let lostJob = false;
  let lostReceipt = false;
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = url.pathname.split("/").at(-1) ?? "";
    const live = [...replicas];
    const [name, origin] = live[Math.floor(Math.random() * live.length)] ?? [];
    if (!name || !origin) throw new TypeError("fetch failed: no replica");
    if (route === "connect") {
      stats.connects++;
      stats.holder = name;
    }
    const chaotic = ["poll", "renew", "complete"].includes(route);
    if (chaotic && Math.random() < 0.2) {
      stats.badGateways++;
      return new Response("Bad Gateway", { status: 502 });
    }
    const response = await globalThis
      .fetch(`${origin}${url.pathname}`, init)
      .catch((error: unknown) => {
        // A replica that stopped leaves rotation, as a health check would.
        replicas.delete(name);
        stats.unreachable++;
        throw error;
      });
    if (!chaotic) return response;
    const body = await response.text();
    // The replica took an operation for this poll, but its answer is lost:
    // the worker must receive that operation when it asks again.
    if (route === "poll" && !lostJob && body.includes('"operation"')) {
      lostJob = true;
      stats.lostJobs++;
      throw new TypeError("fetch failed: socket hang up");
    }
    // The receipt was recorded, but the worker never hears so.
    if (route === "complete" && !lostReceipt && response.ok) {
      lostReceipt = true;
      stats.lostResponses++;
      throw new TypeError("fetch failed: socket hang up");
    }
    if (Math.random() < 0.1) {
      stats.lostResponses++;
      throw new TypeError("fetch failed: socket hang up");
    }
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  };
  return { fetch, stats };
}

it.skipIf(!process.env.DATABASE_URL)(
  "a worker behind a flaky load balancer keeps its session and runs each operation once (ADR 0187)",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-transport-"));
    const servers = new Map<string, WorkServer>();
    const replicas = new Map<string, string>();
    let worker: Awaited<ReturnType<typeof startWorkWorker>> | undefined;
    // Its own database: a deployment's replicas share one origin and
    // secret, which other suites on this server do not.
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    const database = `work_transport_${randomBytes(4).toString("hex")}`;
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
    databaseUrl.pathname = `/${database}`;
    const env = {
      DATABASE_URL: databaseUrl.toString(),
      WORK_SECRET: "transport-test-secret-with-at-least-32-characters",
      WORK_VAULT_KEY: Buffer.alloc(32, 9).toString("base64"),
      WORK_CONTROL_PLANE_WORKLOADS: "workflow",
      WORK_FAKE_AGENT: "1",
      PATH: process.env.PATH,
    };
    try {
      for (const name of ["a", "b"]) {
        const server = await createWorkServer(
          testServerOptions({
            dataDir: path.join(dir, name),
            publicBases: ["https://transport.example.test"],
            env: { ...env, WORK_MACHINE_NAME: name },
          }),
        );
        servers.set(name, server);
        await server.app.listen({ port: 0, host: "127.0.0.1" });
        const address = server.app.server.address();
        if (!address || typeof address === "string")
          throw new Error("No address");
        replicas.set(name, `http://127.0.0.1:${address.port}`);
      }
      const first = servers.get("a");
      if (!first) throw new Error("Replica a must boot");
      const operatorSecret = (
        await fs.readFile(path.join(dir, "a", "operator-secret"), "utf8")
      ).trim();
      const enrollment = await first.operatorApp.inject({
        method: "POST",
        url: "/_work/operator/workers",
        headers: {
          authorization: `Bearer ${operatorSecret}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ name: "flaky", trusted: true }),
      });
      expect(enrollment.statusCode).toBe(201);

      const balancer = flakyBalancer(replicas);
      const log: string[] = [];
      worker = await startWorkWorker({
        controlPlaneUrl: "http://127.0.0.1:1",
        dataDir: path.join(dir, "worker"),
        enrollmentCode: enrollment.json().code,
        execution: executionSettingsFromEnv({
          PATH: process.env.PATH,
          WORK_MAX_WORKSPACES: "2",
        }),
        fetch: balancer.fetch,
        log: (line) => log.push(line),
      });
      await expect
        .poll(() => log.some((line) => line.startsWith("Connected")), {
          timeout: 20_000,
        })
        .toBe(true);
      // The replica holding the lease runs the worker's agents (ADR 0164);
      // the other one serves only the worker's calls routed to it.
      const holder = servers.get(balancer.stats.holder);
      const other = [...servers.keys()].find(
        (name) => name !== balancer.stats.holder,
      );
      if (!holder || !other) throw new Error("Two replicas must serve");
      const a = holder;

      const identity: Identity = {
        tenantId: SERVER_TENANT_ID,
        externalUserId: "transport-test",
      };
      const project = await a.catamorphic.core.projects.create(identity, {
        name: "Flaky network",
      });
      await a.catamorphic.core.deployment.deploy(
        SERVER_TENANT_ID,
        project.id,
        identity.externalUserId,
        {
          message: "Run agents on workers",
          files: {
            ".work/project.json": JSON.stringify({
              environments: {
                build: { pool: { plane: "worker" }, workloads: ["agent"] },
                laptop: { device: "member", workloads: ["agent"] },
              },
              defaultEnvironment: "build",
            }),
          },
        },
      );
      const sessions = a.catamorphic.core.agentSessions;
      if (!sessions) throw new Error("Agent sessions are unavailable");
      const session = await sessions.create(identity, project.id, {
        environment: "build",
      });
      /** Append one byte per step, then count them, in one turn. */
      const turn = async (appends: number): Promise<string> => {
        const reply = await sessions.sendMessage(
          identity,
          project.id,
          session.id,
          [
            ...Array.from({ length: appends }, () => "run printf . >> ops"),
            "run wc -c < ops",
          ].join(" ;; "),
        );
        expect(reply.metadata?.status).not.toBe("failed");
        return reply.content;
      };

      const once = await turn(8);
      expect(once.split("\n---\n").at(-1)?.trim()).toBe("exit=0\n8");

      // A replica stops (a rolling deploy). It stays in the balancer's
      // rotation until calls to it fail; the worker's lease and running
      // work are untouched.
      const stopping = servers.get(other);
      servers.delete(other);
      await stopping?.shutdown();
      const second = await turn(8);
      expect(second.split("\n---\n").at(-1)?.trim()).toBe("exit=0\n16");

      // A member runner's capability lists reach Postgres as JSON arrays,
      // not as Postgres arrays jsonb would misread.
      const runners = a.catamorphic.core.clientRunners;
      if (!runners) throw new Error("Client execution is unavailable");
      const runnerId = randomUUID();
      await runners.register({
        identity,
        projectId: project.id,
        id: runnerId,
        environment: "laptop",
        label: "Laptop",
        workspaceRoot: "/workspace",
        resourceLimits: ["cpuMillis"],
        capabilities: ["images"],
      });
      const binding = await runners.binding({
        tenantId: SERVER_TENANT_ID,
        ownerUserId: identity.externalUserId,
        projectId: project.id,
        clientRunnerId: runnerId,
      });
      expect(binding?.descriptor.capabilities).toContain("images");
      expect(binding?.descriptor.resourceLimits).toEqual(["cpuMillis"]);

      expect(balancer.stats.badGateways).toBeGreaterThan(0);
      expect(balancer.stats.unreachable).toBeGreaterThan(0);
      expect(balancer.stats.lostJobs).toBe(1);
      expect(balancer.stats.lostResponses).toBeGreaterThan(0);
      // One session throughout: the worker never had to connect again.
      expect(balancer.stats.connects).toBe(1);
      expect(
        log.filter((line) => line.startsWith("Worker session ended")),
      ).toEqual([]);
    } finally {
      await worker?.stop();
      for (const server of servers.values()) await server.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  },
  180_000,
);
