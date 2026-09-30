import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "../server.js";
import { dropTestDatabase, testServerOptions } from "../test-support.js";

/**
 * Sign-in limits (issue #150): Better Auth's 3 sign-ins per 10 seconds per
 * client address, on whatever NODE_ENV says, counted in the database, with
 * the client resolved behind trusted proxies.
 */
const PASSWORD = "correct horse battery staple";

function attempt(
  server: WorkServer,
  from: { peer: string; forwardedFor?: string },
) {
  return server.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/username",
    remoteAddress: from.peer,
    headers: from.forwardedFor ? { "x-forwarded-for": from.forwardedFor } : {},
    payload: { username: "ada", password: "not the password" },
  });
}

/** Seconds a refused client is told to wait: within the 10 second window. */
async function refusedFor(
  refused: Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | number | undefined>;
  }>,
): Promise<number> {
  const response = await refused;
  expect(response.statusCode).toBe(429);
  return Number(response.headers["x-retry-after"]);
}

async function statuses(
  attempts: Array<() => Promise<{ statusCode: number }>>,
): Promise<number[]> {
  const result: number[] = [];
  for (const run of attempts) result.push((await run()).statusCode);
  return result;
}

describe("sign-in limits on one server", () => {
  it("refuses the fourth sign-in from one address and never believes a client's own x-forwarded-for", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-limits-"));
    const server = await createWorkServer(
      testServerOptions({
        dataDir,
        env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
      }),
    );
    try {
      await server.workAuth.createLocalUser({
        username: "ada",
        name: "Ada",
        password: PASSWORD,
      });
      const direct = { peer: "203.0.113.7" };
      expect(
        await statuses([
          () => attempt(server, direct),
          () => attempt(server, direct),
          () => attempt(server, direct),
          () => attempt(server, direct),
        ]),
      ).toEqual([401, 401, 401, 429]);
      // Rotating a made-up forwarded address changes nothing: no proxy
      // is trusted, so the connection's peer is the client.
      const wait = await refusedFor(
        attempt(server, { peer: "203.0.113.7", forwardedFor: "198.51.100.23" }),
      );
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(10);
      expect((await attempt(server, { peer: "203.0.113.8" })).statusCode).toBe(
        401,
      );
      // The sign-in page says why rather than blaming the password.
      const page = await server.app.inject({
        method: "POST",
        url: "/login/local",
        remoteAddress: "203.0.113.7",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          username: "ada",
          password: PASSWORD,
        }).toString(),
      });
      expect(page.statusCode).toBe(302);
      expect(String(page.headers.location)).toContain("error=limited");
      const shown = await server.app.inject({
        method: "GET",
        url: String(page.headers.location),
      });
      expect(shown.body).toContain("Too many sign-in attempts");
    } finally {
      await server.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("lets a test server turn the limits off through config", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-limits-"));
    const server = await createWorkServer(
      testServerOptions({
        dataDir,
        env: {
          WORK_FAKE_AGENT: "1",
          WORK_AUTH_RATE_LIMIT: "off",
          PATH: process.env.PATH,
        },
      }),
    );
    try {
      await server.workAuth.createLocalUser({
        username: "ada",
        name: "Ada",
        password: PASSWORD,
      });
      const from = { peer: "203.0.113.7" };
      expect(
        await statuses(
          Array.from({ length: 5 }, () => () => attempt(server, from)),
        ),
      ).toEqual([401, 401, 401, 401, 401]);
    } finally {
      await server.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});

it.skipIf(!process.env.DATABASE_URL)(
  "two replicas behind a proxy share one limit per client address",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-limits-"));
    const servers: WorkServer[] = [];
    // Its own database: a deployment's replicas share one origin and
    // secret, which other suites on this server do not.
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    const database = `work_limits_${randomBytes(4).toString("hex")}`;
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
    databaseUrl.pathname = `/${database}`;
    try {
      for (const name of ["a", "b"]) {
        servers.push(
          await createWorkServer(
            testServerOptions({
              dataDir: path.join(dir, name),
              publicBases: ["https://limits.example.test"],
              env: {
                DATABASE_URL: databaseUrl.toString(),
                WORK_SECRET: "limits-test-secret-with-at-least-32-characters",
                WORK_VAULT_KEY: Buffer.alloc(32, 5).toString("base64"),
                WORK_MACHINE_NAME: name,
                WORK_CONTROL_PLANE_WORKLOADS: "workflow",
                WORK_TRUSTED_PROXIES: "10.0.0.0/8",
                WORK_FAKE_AGENT: "1",
                PATH: process.env.PATH,
              },
            }),
          ),
        );
      }
      const [a, b] = servers;
      if (!a || !b) throw new Error("Both replicas must boot");
      await a.workAuth.createLocalUser({
        username: "ada",
        name: "Ada",
        password: PASSWORD,
      });
      // The balancer (10.0.0.x) appends the address it saw to whatever the
      // client sent, and each attempt lands on the other replica.
      const via = (balancer: string, client: string, spoof: string) => ({
        peer: balancer,
        forwardedFor: `${spoof}, ${client}`,
      });
      expect(
        await statuses([
          () => attempt(a, via("10.0.0.5", "203.0.113.7", "198.51.100.1")),
          () => attempt(b, via("10.0.0.6", "203.0.113.7", "198.51.100.2")),
          () => attempt(a, via("10.0.0.5", "203.0.113.7", "198.51.100.3")),
          () => attempt(b, via("10.0.0.6", "203.0.113.7", "198.51.100.4")),
          () => attempt(a, via("10.0.0.5", "203.0.113.7", "198.51.100.5")),
        ]),
      ).toEqual([401, 401, 401, 429, 429]);
      const wait = await refusedFor(
        attempt(b, via("10.0.0.6", "203.0.113.7", "198.51.100.6")),
      );
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(10);
      expect(
        await statuses([
          () => attempt(b, via("10.0.0.6", "203.0.113.8", "203.0.113.7")),
          () => attempt(a, via("10.0.0.5", "203.0.113.9", "203.0.113.7")),
        ]),
      ).toEqual([401, 401]);
      // The count lives in the auth schema, not in either replica.
      const counted = new pg.Client({
        connectionString: databaseUrl.toString(),
      });
      await counted.connect();
      try {
        const rows = await counted.query<{ key: string; count: number }>(
          `SELECT key, count FROM catamorphic_auth."rateLimit" WHERE key LIKE '203.0.113.7|%'`,
        );
        expect(rows.rows).toEqual([
          { key: "203.0.113.7|/sign-in/username", count: 3 },
        ]);
      } finally {
        await counted.end();
      }
    } finally {
      for (const server of servers) await server.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
      await dropTestDatabase({ admin, database });
      await admin.end();
    }
  },
  180_000,
);
