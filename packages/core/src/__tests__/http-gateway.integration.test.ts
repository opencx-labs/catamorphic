import crypto from "node:crypto";
import http from "node:http";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import type { Sandboxing } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { ConnectionBroker } from "../services/connection-broker.js";
import { ConnectionCapabilityGrantsService } from "../services/connection-capability-grants.js";
import type { ConnectionActionContext } from "../services/connection-guards.js";
import {
  type ConnectionProvider,
  ConnectionProviderRegistry,
} from "../services/connection-providers.js";
import { ConnectionsService } from "../services/connections-service.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import {
  dbHttpGatewayStore,
  type HttpGatewayRequest,
  type HttpGatewayResponse,
  HttpGatewayService,
  httpUpstreamTarget,
} from "../services/http-gateway.js";

/*
 * HTTP APIs through the gateway for code in sandboxes (ADR 0211), with the
 * real broker, grants and audit over an embedded database, and a fake API
 * on this machine that holds the only valid keys.
 */

const db = new Kysely<DB>({
  dialect: new PGliteDialect({
    pglite: new PGlite({ extensions: { pgcrypto } }),
  }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const admin: Identity = {
  tenantId,
  externalUserId: "admin",
  controlPlanePermissions: ["connections:read", "connections:write"],
};
const LOGS_KEY = "reader:logs-password";
const BILLING_KEY = "sk-billing-real";
const BIG_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder();

/** What the fake API saw: never the caller's own authorization. */
interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  grantHeader: string | undefined;
  custom: string | undefined;
  body: string;
}
const seen: Seen[] = [];
/** Bytes the fake API has handed its socket for `/big`. */
const big = { written: 0 };

function fakeApi(): http.Server {
  return http.createServer((request, response) => {
    if (request.url === "/big") {
      const chunk = Buffer.alloc(64 * 1024, 120);
      response.writeHead(200, { "content-type": "application/octet-stream" });
      const pump = () => {
        while (big.written < BIG_BYTES) {
          big.written += chunk.length;
          if (!response.write(chunk)) {
            response.once("drain", pump);
            return;
          }
        }
        response.end();
      };
      pump();
      return;
    }
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        grantHeader: request.headers["x-work-grant"]?.toString(),
        custom: request.headers["x-custom"]?.toString(),
        body: Buffer.concat(parts).toString("utf8"),
      });
      const basic = `Basic ${Buffer.from(LOGS_KEY).toString("base64")}`;
      const valid =
        request.headers.authorization === basic ||
        request.headers.authorization === `Bearer ${BILLING_KEY}`;
      if (!valid) {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("wrong key\n");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": "upstream=1",
        "x-upstream": "yes",
      });
      response.end(`${request.method} ${request.url} ${parts.length}\n`);
    });
  });
}

/** Administrators authorize these fakes by pasting a key. */
function pastedKey(
  kind: string,
): Pick<ConnectionProvider, "beginAuthorization" | "completeAuthorization"> {
  return {
    beginAuthorization: async () => ({
      challenge: {
        kind: "form",
        fields: [
          { name: "apiKey", label: "Key", secret: true, required: true },
        ],
      },
    }),
    completeAuthorization: async ({ callback }) => ({
      material: new TextEncoder().encode(callback.apiKey ?? ""),
      account: { kind },
      capabilities: ["get", "post", "put", "patch", "delete"],
    }),
  };
}

async function text(response: HttpGatewayResponse): Promise<string> {
  if (response.body instanceof Uint8Array) return decoder.decode(response.body);
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return decoder.decode(Buffer.concat(chunks));
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("HTTP APIs through the gateway (ADR 0211)", () => {
  const upstream = fakeApi();
  const base = { url: "" };
  const reads = (action: string) => action === "get";
  const providers = new ConnectionProviderRegistry([
    {
      kind: "logs",
      displayName: "Logs",
      ...pastedKey("logs"),
      readOnly: reads,
      http: {
        get baseUrl() {
          return base.url;
        },
        headers: ({ material }) => ({
          authorization: `Basic ${Buffer.from(material).toString("base64")}`,
        }),
      },
      invoke: async () => ({}),
    },
    {
      kind: "billing",
      displayName: "Billing",
      ...pastedKey("billing"),
      readOnly: reads,
      http: {
        get baseUrl() {
          return `${base.url}/v1`;
        },
        paths: ["/invoices"],
        headers: ({ material }) => ({
          authorization: `Bearer ${decoder.decode(material)}`,
        }),
      },
      invoke: async () => ({}),
    },
  ]);
  const connections = new ConnectionsService({
    db,
    vault: new MemoryCredentialVault(),
    providers,
    // What `.work/project.json` commits for the `dev` Environment: logs
    // narrowed to reads and POST queries; billing keeps the connection's own.
    bindings: async () => ({
      logs: {
        provider: "logs",
        principal: "service",
        service: "logs",
        capabilities: ["get", "post"],
      },
      billing: {
        provider: "billing",
        principal: "service",
        service: "billing",
      },
    }),
  });
  const allocations = new ExecutionAllocationsService(db);
  const grants = new ConnectionCapabilityGrantsService(db, allocations);
  const reviewed: ConnectionActionContext[] = [];
  const sandboxing: { value: Sandboxing | undefined } = { value: undefined };
  const broker = new ConnectionBroker(
    connections,
    providers,
    allocations,
    undefined,
    {
      guards: [
        {
          name: "locked invoices",
          kinds: ["billing"],
          review: async (context) => {
            reviewed.push(context);
            const input = context.input;
            const path =
              typeof input === "object" &&
              input !== null &&
              !Array.isArray(input)
                ? String(input.path)
                : "";
            return path.startsWith("/invoices/locked")
              ? { verdict: "deny", reason: "locked invoices are off limits" }
              : { verdict: "allow" };
          },
        },
      ],
      sessionSandboxing: async () => sandboxing.value,
    },
  );
  const gateway = new HttpGatewayService({
    store: dbHttpGatewayStore(db),
    broker,
  });
  const session = { id: crypto.randomUUID(), allocationId: "" };

  const call = (
    request: Partial<HttpGatewayRequest> &
      Pick<HttpGatewayRequest, "alias" | "headers">,
  ) =>
    gateway.handle({
      method: "GET",
      path: "",
      ...request,
    });
  const issue = async (alias: string, channel: "sandbox" | "mcp" = "sandbox") =>
    (
      await grants.issue({
        identity: admin,
        allocationId: session.allocationId,
        agentSessionId: session.id,
        alias,
        channel,
      })
    ).token;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const audits = () =>
    db
      .selectFrom("connection_audit_events")
      .selectAll()
      .where("event_type", "=", "connection.http")
      .orderBy("id")
      .execute();

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("The fake API has no address");
    base.url = `http://127.0.0.1:${address.port}`;
    await migrateToLatest({ db, schema: DEFAULT_SCHEMA });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "P" })
      .execute();
    for (const [name, key] of [
      ["logs", LOGS_KEY],
      ["billing", BILLING_KEY],
    ] as const) {
      const service = await connections.createService({
        identity: admin,
        name,
        providerKind: name,
        principalKind: "project_service",
        projectId,
      });
      const started = await connections.beginServiceAuthorization({
        identity: admin,
        connectionId: service.id,
        redirectUri: "https://work.test/api/connection-authorizations/callback",
      });
      await connections.completeAuthorization({
        identity: admin,
        state: started.authorizationId,
        callback: { apiKey: key },
      });
    }
    const resolved = await connections.resolve({
      identity: admin,
      projectId,
      environment: "dev",
      aliases: ["logs", "billing"],
      principalsByAlias: { logs: "service", billing: "service" },
    });
    session.allocationId = (
      await allocations.create({
        identity: admin,
        projectId,
        environmentName: "dev",
        workloadKind: "agent",
        rootWorkloadId: session.id,
        policy: {
          binding: {
            id: "managed",
            label: "Managed",
            trust: "managed",
            isolation: "sandbox",
            workloads: ["agent"],
            agentTopologies: ["controller"],
            capabilities: [],
            resources: {},
          },
          requirements: { workload: "agent", topology: "controller" },
          connections: resolved,
        },
      })
    ).id;
    await db
      .insertInto("agent_sessions")
      .values({
        id: session.id,
        project_id: projectId,
        external_user_id: "member-1",
        allocation_id: session.allocationId,
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await db.destroy();
  });

  it("passes GET and POST through with the stored key, never the caller's", async () => {
    const grant = await issue("logs");
    seen.length = 0;
    // ClickHouse's HTTP interface: the base itself, the query in the URL.
    const read = await call({
      alias: "logs",
      query: "query=SELECT%201",
      headers: {
        authorization: `Basic ${Buffer.from(`anyone:${grant}`).toString("base64")}`,
        "x-custom": "kept",
        cookie: "session=caller",
      },
    });
    expect(read.status).toBe(200);
    expect(await text(read)).toBe("GET /?query=SELECT%201 0\n");
    expect(read.headers["x-upstream"]).toBe("yes");
    expect(read.headers["set-cookie"]).toBeUndefined();
    // The body travels byte for byte, the grant as `x-work-grant` while
    // the caller's own `Authorization` is dropped.
    const insert = await call({
      alias: "logs",
      method: "POST",
      path: "/",
      query: "query=INSERT%20INTO%20t%20FORMAT%20JSONEachRow",
      headers: {
        "x-work-grant": grant,
        authorization: "Bearer callers-own-token",
        "content-type": "application/x-ndjson",
      },
      body: new TextEncoder().encode('{"a":1}\n{"a":2}\n'),
    });
    expect(insert.status).toBe(200);
    expect(await text(insert)).toMatch(/^POST \/\?query=INSERT/);
    const billingGrant = await issue("billing");
    const invoice = await call({
      alias: "billing",
      path: "/invoices/42",
      headers: bearer(billingGrant),
    });
    expect(invoice.status).toBe(200);
    expect(await text(invoice)).toBe("GET /v1/invoices/42 0\n");

    const basic = `Basic ${Buffer.from(LOGS_KEY).toString("base64")}`;
    expect(
      seen.map(({ method, url, authorization, body }) => ({
        method,
        url,
        authorization,
        body,
      })),
    ).toEqual([
      {
        method: "GET",
        url: "/?query=SELECT%201",
        authorization: basic,
        body: "",
      },
      {
        method: "POST",
        url: "/?query=INSERT%20INTO%20t%20FORMAT%20JSONEachRow",
        authorization: basic,
        body: '{"a":1}\n{"a":2}\n',
      },
      {
        method: "GET",
        url: "/v1/invoices/42",
        authorization: `Bearer ${BILLING_KEY}`,
        body: "",
      },
    ]);
    expect(seen.every((request) => request.grantHeader === undefined)).toBe(
      true,
    );
    expect(seen[0]?.custom).toBe("kept");

    // Each request is audited with its path and query, never its body.
    await waitFor(async () => (await audits()).length >= 3);
    const rows = await audits();
    expect(
      rows.map((row) => ({ action: row.action, outcome: row.outcome })),
    ).toEqual([
      { action: "get", outcome: "allowed" },
      { action: "post", outcome: "allowed" },
      { action: "get", outcome: "allowed" },
    ]);
    expect(rows[0]?.actor_external_user_id).toBe("member-1");
    expect(rows[0]?.metadata).toMatchObject({
      sessionId: session.id,
      input: { path: "/", query: { query: "SELECT 1" } },
      status: 200,
    });
    expect(JSON.stringify(rows)).not.toContain('{"a":1}');
    expect(JSON.stringify(rows)).not.toContain(grant);
  });

  it("refuses paths outside the binding's paths or the base URL", async () => {
    const grant = await issue("billing");
    seen.length = 0;
    const outside = await call({
      alias: "billing",
      path: "/customers",
      headers: bearer(grant),
    });
    expect(outside.status).toBe(403);
    expect(await text(outside)).toContain("outside the paths 'billing' allows");
    for (const path of [
      "/invoices/../customers",
      "/invoices/%2e%2e/customers",
      "/invoices/a%2Fb",
      "/invoices//x",
    ]) {
      const escaped = await call({
        alias: "billing",
        path,
        headers: bearer(grant),
      });
      expect(escaped.status, path).toBe(404);
    }
    expect(seen).toEqual([]);
    expect(
      httpUpstreamTarget({
        alias: "billing",
        baseUrl: "https://api.test/v1",
        paths: ["/invoices"],
        path: "/invoicesX",
      }),
    ).toHaveProperty("refused");
  });

  it("refuses a method outside the binding's capabilities, readably and audited", async () => {
    const grant = await issue("logs");
    seen.length = 0;
    const put = await call({
      alias: "logs",
      method: "PUT",
      path: "/t",
      headers: bearer(grant),
    });
    expect(put.status).toBe(403);
    expect(JSON.parse(await text(put))).toEqual({
      error: {
        status: 403,
        message:
          "Refused: this session may not send PUT through 'logs' (it lacks put)",
      },
    });
    const options = await call({
      alias: "logs",
      method: "OPTIONS",
      headers: bearer(grant),
    });
    expect(options.status).toBe(405);
    expect(options.headers.allow).toContain("PATCH");
    expect(seen).toEqual([]);
    const denied = (await audits()).filter((row) => row.outcome === "denied");
    expect(denied.at(-1)).toMatchObject({
      action: "put",
      metadata: { reason: "missing put" },
    });
  });

  it("answers a guard's denial with its reason, and shows guards no credential or body", async () => {
    const grant = await issue("billing");
    reviewed.length = 0;
    seen.length = 0;
    const locked = await call({
      alias: "billing",
      method: "POST",
      path: "/invoices/locked/1",
      query: "expand=lines&expand=tax",
      headers: bearer(grant),
      body: new TextEncoder().encode('{"secret":"body"}'),
    });
    expect(locked.status).toBe(403);
    expect(JSON.parse(await text(locked)).error.message).toBe(
      "Refused: locked invoices are off limits",
    );
    expect(seen).toEqual([]);
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toMatchObject({
      actor: "member-1",
      caller: "agent",
      agentSessionId: session.id,
      connection: { kind: "billing", alias: "billing" },
      action: "post",
      input: {
        path: "/invoices/locked/1",
        query: { expand: ["lines", "tax"] },
      },
    });
    const shown = JSON.stringify(reviewed);
    expect(shown).not.toContain(BILLING_KEY);
    expect(shown).not.toContain(grant);
    expect(shown).not.toContain("secret");
    expect((await audits()).at(-1)).toMatchObject({
      action: "post",
      outcome: "denied",
    });
  });

  it("lets a contained agent's session read but never write (ADR 0182)", async () => {
    sandboxing.value = "contained";
    try {
      // A new grant: an alias's resolution is reused per grant.
      const grant = await issue("logs");
      seen.length = 0;
      const head = await call({
        alias: "logs",
        method: "HEAD",
        path: "/",
        headers: bearer(grant),
      });
      expect(head.status).toBe(200);
      const get = await call({
        alias: "logs",
        path: "/",
        headers: bearer(grant),
      });
      expect(get.status).toBe(200);
      const post = await call({
        alias: "logs",
        method: "POST",
        path: "/",
        headers: bearer(grant),
        body: new TextEncoder().encode("SELECT 1"),
      });
      expect(post.status).toBe(403);
      expect(await text(post)).toContain("sandboxing is contained");
      expect(seen.map((request) => request.method)).toEqual(["HEAD", "GET"]);
    } finally {
      sandboxing.value = undefined;
    }
  });

  it("refuses unknown, expired, revoked, renewed, MCP and other aliases' grants with 401", async () => {
    seen.length = 0;
    const unknown = await call({
      alias: "logs",
      headers: bearer("not-a-grant"),
    });
    expect(unknown.status).toBe(401);
    expect(unknown.headers["www-authenticate"]).toContain("Basic");
    expect((await call({ alias: "logs", headers: {} })).status).toBe(401);

    // Renewing issues a new bearer: only the grant file's current one works.
    const first = await issue("logs");
    const renewed = await issue("logs");
    expect((await call({ alias: "logs", headers: bearer(first) })).status).toBe(
      401,
    );
    expect(
      (await call({ alias: "logs", headers: bearer(renewed) })).status,
    ).toBe(200);
    // A grant names one alias, on the sandbox channel only.
    expect(
      (
        await call({
          alias: "billing",
          path: "/invoices",
          headers: bearer(renewed),
        })
      ).status,
    ).toBe(401);
    const mcp = await issue("logs", "mcp");
    expect((await call({ alias: "logs", headers: bearer(mcp) })).status).toBe(
      401,
    );

    await db
      .updateTable("connection_capability_grants")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(
        "token_hash",
        "=",
        crypto.createHash("sha256").update(renewed).digest("hex"),
      )
      .execute();
    expect(
      (await call({ alias: "logs", headers: bearer(renewed) })).status,
    ).toBe(401);

    const revoked = await issue("logs");
    expect(
      (await call({ alias: "logs", headers: bearer(revoked) })).status,
    ).toBe(200);
    await grants.revokeAllocation({ allocationId: session.allocationId });
    expect(
      (await call({ alias: "logs", headers: bearer(revoked) })).status,
    ).toBe(401);
    expect(seen).toHaveLength(2);
  });

  it("checks the grant before the body, and once per admitted request", async () => {
    const refused = await gateway.admit({
      alias: "logs",
      headers: bearer("nope"),
    });
    expect("refused" in refused && refused.refused.status).toBe(401);
    const grant = await issue("logs");
    const admitted = await gateway.admit({
      alias: "logs",
      headers: bearer(grant),
    });
    if (!("admitted" in admitted)) throw new Error("Not admitted");
    // Revoked after admission: the admission stands for its own request.
    await grants.revokeAllocation({ allocationId: session.allocationId });
    const response = await gateway.handle({
      alias: "logs",
      method: "GET",
      path: "/",
      headers: bearer(grant),
      admitted: admitted.admitted,
    });
    expect(response.status).toBe(200);
  });

  it("streams a large answer through without holding it whole", async () => {
    const grant = await issue("logs");
    big.written = 0;
    const response = await call({
      alias: "logs",
      path: "/big",
      headers: bearer(grant),
    });
    expect(response.status).toBe(200);
    if (response.body instanceof Uint8Array) throw new Error("Not streamed");
    const iterator = response.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // The API waits on the reader: far less than the whole answer left it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(big.written).toBeLessThan(BIG_BYTES / 2);
    let total = first.value?.byteLength ?? 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      total += next.value.byteLength;
    }
    expect(total).toBe(BIG_BYTES);
  }, 60_000);
});
