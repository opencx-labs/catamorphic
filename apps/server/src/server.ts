import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type ConnectionProvider,
  type Identity,
  ToolPermissionBroker,
} from "@catamorphic/core";
import { type DB, DEFAULT_SCHEMA } from "@catamorphic/db";
import {
  createApp,
  identityFromBearer,
  serveSpaDist,
} from "@catamorphic/fastify-plugin";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import {
  type Catamorphic,
  createCatamorphic,
  defineStaticEnvironments,
  FsBundleStore,
} from "@catamorphic/server-sdk";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { StockAdmissionService } from "./admission/admission-service.js";
import { registerStockAdmissionRoutes } from "./admission/routes.js";
import { buildAgentRegistry } from "./agents.js";
import { loadStockAuthConfig } from "./auth/auth-config.js";
import { openStockAuthDatabase } from "./auth/auth-database.js";
import { registerStockAuthRoutes } from "./auth/fastify-auth.js";
import {
  createStockAuth,
  loadStockAuthSecret,
  type StockAuth,
} from "./auth/stock-auth.js";
import { EncryptedFileCredentialVault } from "./credential-vault.js";
import {
  loadStockOperatorSecret,
  verifyStockOperatorSecret,
} from "./setup/operator-access.js";
import {
  ProvisionStockUserInputSchema,
  provisionStockUser,
} from "./setup/provision.js";
import {
  ProvisionStockProjectInputSchema,
  provisionStockProject,
} from "./setup/provision-project.js";

/**
 * The stock Catamorphic server (ADR 0059): everything on disk under one
 * data dir, zero external services. PGlite for the database, bare git
 * repos for project origins, local-process execution (the container is
 * the sandbox, single-tenant only per ADR 0047), stock OAuth, and ordinary
 * project-role administration.
 */

/** Single-tenant, like the desktop: one fixed tenant for the machine. */
export const SERVER_TENANT_ID = "00000000-0000-4000-8000-0000000005e1";

const SETUP_AGENT_USER = "stock-setup-agent";

export interface StockServerOptions {
  dataDir: string;
  /** Public bases, without a trailing slash, used in discovery and links. */
  publicBases?: string[];
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  connectionProviders?: readonly ConnectionProvider[];
}

export interface StockServer {
  /** Public application, OAuth, PWA, and scoped Catamorphic API. */
  app: FastifyInstance;
  /** Machine-local setup API. The host must bind this only to loopback. */
  operatorApp: FastifyInstance;
  catamorphic: Catamorphic;
  /** Stock-host authentication and OAuth authorization server. */
  stockAuth: StockAuth;
  agentsDescription: string;
  shutdown(): Promise<void>;
}

export async function buildStockServer(
  options: StockServerOptions,
): Promise<StockServer> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const data = options.dataDir;
  for (const dir of ["db", "projects", "remotes", "app-bundles", "sandboxes"]) {
    fs.mkdirSync(path.join(data, dir), { recursive: true });
  }
  const hostId = loadOrCreateHostId(path.join(data, "host-id"));

  // --- database: PGlite on disk, or DATABASE_URL for teams ------------
  // PGlite is the zero-dependency default (one serialized connection);
  // pointing DATABASE_URL at real Postgres is the scale-up path — the
  // rest of the server is identical.
  let ownDb: Kysely<DB> | undefined;
  let workerConcurrency = 1;
  let databaseConfig: { db: Kysely<DB> } | { connectionString: string };
  if (env.DATABASE_URL) {
    databaseConfig = { connectionString: env.DATABASE_URL };
    workerConcurrency = 4;
  } else {
    const pglite = new PGlite(path.join(data, "db"), {
      extensions: { pgcrypto },
    });
    ownDb = new Kysely<DB>({
      dialect: new PGliteDialect({ pglite }),
      plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
    });
    // WithSchemaPlugin only rewrites built queries; core's raw-SQL paths
    // (the worker's claim CTE) resolve tables via search_path. PGlite is
    // one session for the process's lifetime, so set it once here.
    await sql
      .raw(`SET search_path TO "${DEFAULT_SCHEMA}", public`)
      .execute(ownDb);
    databaseConfig = { db: ownDb };
  }

  // --- execution: the container is the sandbox (ADR 0047) -------------
  const sandboxProvider = new LocalProcessSandboxProvider({
    root: path.join(data, "sandboxes"),
    env: {
      PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
    },
  });
  const environmentProvider = defineStaticEnvironments([
    {
      descriptor: {
        id: "local",
        label: "Managed single node",
        description: "Run on this server",
        trust: "managed",
        isolation: "process",
        workloads: ["agent", "workflow"],
        agentTopologies: ["controller"],
        capabilities: ["network.egress"],
        resources: {},
      },
      sandboxProvider,
    },
  ]);

  // Tool-permission asks park here; clients answer over HTTP (ADR 0054).
  const toolPermissions = new ToolPermissionBroker();
  const agents = buildAgentRegistry({ sandboxProvider, toolPermissions, env });

  const catamorphic = createCatamorphic({
    hostId,
    database: databaseConfig,
    storage: {
      projectsPath: path.join(data, "projects"),
      remotesPath: path.join(data, "remotes"),
    },
    sandboxProvider,
    environmentProvider,
    credentialVault: new EncryptedFileCredentialVault(
      path.join(data, "credentials"),
    ),
    connectionProviders: options.connectionProviders,
    connectionMcpUrl: () => {
      const base = options.publicBases?.[0];
      return base ? `${base}/api/connection-mcp` : undefined;
    },
    ...(agents.registry ? { codingAgent: agents.registry } : {}),
    appBundleStore: new FsBundleStore(path.join(data, "app-bundles")),
    toolPermissions,
  });
  await catamorphic.migrate();

  // Better Auth is a stock-host concern. Its PGlite database is separate
  // from Catamorphic's long-lived PGlite session; network Postgres uses the
  // dedicated catamorphic_auth schema.
  const stockAuthDatabase = await openStockAuthDatabase({
    dataDir: data,
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
  });
  const stockAuthConfig = loadStockAuthConfig({
    dataDir: data,
    ...(env.CATAMORPHIC_AUTH_CONFIG
      ? { configuredPath: env.CATAMORPHIC_AUTH_CONFIG }
      : {}),
  });
  const stockAuth = createStockAuth({
    database: stockAuthDatabase,
    baseURL: options.publicBases?.[0] ?? "http://127.0.0.1:4700",
    secret: loadStockAuthSecret({
      dataDir: data,
      ...(env.BETTER_AUTH_SECRET
        ? { configuredSecret: env.BETTER_AUTH_SECRET }
        : {}),
    }),
    config: stockAuthConfig,
  });
  await stockAuth.migrate();

  // PGlite is a single serialized connection: one worker lane there;
  // real Postgres gets a few.
  const worker = catamorphic.startExecutionWorker({
    name: "stock-server",
    concurrency: workerConcurrency,
  });
  const core = catamorphic.core;

  const operatorSecret = loadStockOperatorSecret({
    dataDir: data,
    ...(env.CATAMORPHIC_OPERATOR_SECRET
      ? { configuredSecret: env.CATAMORPHIC_OPERATOR_SECRET }
      : {}),
  });
  const rootIdentity: Identity = {
    tenantId: SERVER_TENANT_ID,
    externalUserId: SETUP_AGENT_USER,
  };

  // --- HTTP: the standard API app + the server's own routes -----------
  const publicBase = options.publicBases?.[0] ?? "http://127.0.0.1:4700";
  const app = createApp({
    core,
    identity: identityFromBearer(async (token) => {
      const authenticated = await stockAuth.resolveAccessToken({
        authorization: `Bearer ${token}`,
      });
      if (!authenticated) return null;
      return core.memberships.identityForUser({
        tenantId: SERVER_TENANT_ID,
        externalUserId: authenticated.userId,
      });
    }),
    features: { publications: "members" },
  });
  app.addHook("onSend", (request, reply, payload, done) => {
    if (reply.statusCode !== 401 || !request.url.startsWith("/api/")) {
      done(null, payload);
      return;
    }
    const authorization = request.headers.authorization;
    const hasBearer = /^Bearer\s+\S+/i.test(
      Array.isArray(authorization)
        ? (authorization[0] ?? "")
        : (authorization ?? ""),
    );
    const resourceMetadata = `${publicBase}/.well-known/oauth-protected-resource`;
    reply.header(
      "www-authenticate",
      `Bearer resource_metadata="${resourceMetadata}"${
        hasBearer ? ', error="invalid_token"' : ""
      }`,
    );
    done(null, payload);
  });
  registerStockAuthRoutes(app, {
    auth: stockAuth,
    baseURL: publicBase,
    methods: stockAuthConfig.publicMethods(),
  });
  const admission = new StockAdmissionService({
    db: core.db,
    membershipWriterIdentity: rootIdentity,
    roles: core.roles,
    memberships: core.memberships,
  });
  registerStockAdmissionRoutes(app, {
    publicBases: options.publicBases ?? [],
    auth: stockAuth,
    identityForUser: ({ externalUserId }) =>
      core.memberships.identityForUser({
        tenantId: SERVER_TENANT_ID,
        externalUserId,
      }),
    admission,
  });

  app.get("/healthz", async () => ({
    ok: true,
    agentSessions: Boolean(core.agentSessions),
  }));

  // Machine-local setup authority lives on a separate server, not merely a
  // guarded route on the public app. Binding this app only to loopback keeps
  // reverse proxies and other public ingress from reaching the operations.
  // It is deliberately not an application user or role: a setup agent reads
  // the owner-only credential from the mounted data directory and invokes it
  // from the same machine or container.
  const operatorApp = Fastify();
  operatorApp.post(
    "/_catamorphic/operator/projects",
    async (request, reply) => {
      const authorization = Array.isArray(request.headers.authorization)
        ? request.headers.authorization[0]
        : request.headers.authorization;
      if (!verifyStockOperatorSecret(authorization, operatorSecret)) {
        return reply
          .status(401)
          .send({ error: "Operator credential required" });
      }
      const parsed = ProvisionStockProjectInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid project setup input",
          issues: parsed.error.issues,
        });
      }
      try {
        const result = await provisionStockProject({
          services: {
            projects: core.projects,
            deployment: core.deployment,
            roles: core.roles,
            admission,
          },
          operatorIdentity: rootIdentity,
          input: parsed.data,
        });
        return reply.status(201).send(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Project setup failed";
        return reply.status(400).send({ error: message });
      }
    },
  );

  operatorApp.post("/_catamorphic/operator/users", async (request, reply) => {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    if (!verifyStockOperatorSecret(authorization, operatorSecret)) {
      return reply.status(401).send({ error: "Operator credential required" });
    }
    const parsed = ProvisionStockUserInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid provisioning input",
        issues: parsed.error.issues,
      });
    }
    try {
      const result = await provisionStockUser({
        auth: stockAuth,
        services: core,
        operatorIdentity: rootIdentity,
        input: parsed.data,
      });
      return reply.status(201).send(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Provision failed";
      return reply.status(400).send({ error: message });
    }
  });

  // The mobile PWA, served from THIS origin (workspace sibling in dev,
  // CATAMORPHIC_PWA_DIST in the Docker image). Serving it here is what
  // makes phones work away from any LAN: invitation links can point at
  // `https://server/?server=…&project=…&invitation=…`, the app installs from a stable
  // (ideally https) origin, and its service worker caches the shell.
  // Without a bundle, a minimal landing page answers instead.
  const pwaDist =
    env.CATAMORPHIC_PWA_DIST ??
    path.resolve(import.meta.dirname, "../../pwa/dist");
  serveSpaDist(
    app,
    () => pwaDist,
    (reply) => reply.type("text/html").send(LANDING_PAGE),
  );

  log(`agents: ${agents.description}`);

  return {
    app,
    operatorApp,
    catamorphic,
    stockAuth,
    agentsDescription: agents.description,
    shutdown: async () => {
      await worker.stop();
      await Promise.all([app.close(), operatorApp.close()]);
      await stockAuth.close();
      // For DATABASE_URL, close() also destroys the pool it created; the
      // host-owned PGlite Kysely is ours to flush.
      await catamorphic.close();
      await ownDb?.destroy();
    },
  };
}

function loadOrCreateHostId(file: string): string {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // First boot creates a stable identity below.
  }
  const hostId = `server:${randomUUID()}`;
  fs.writeFileSync(file, `${hostId}\n`, { mode: 0o600 });
  return hostId;
}

const LANDING_PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Catamorphic server</title>
<body style="margin:0;display:grid;place-items:center;min-height:100dvh;background:#0a0a0b;color:#e6e6e9;font-family:system-ui">
<div style="text-align:center;padding:2rem">
<svg width="72" height="72" viewBox="0 0 64 64" fill="none"><path d="M45 19.5 C41.7 17.2 37.6 15.8 33.5 15.8 C24 15.8 16.5 23 16.5 32 C16.5 41 24 48.2 33.5 48.2 C37.6 48.2 41.7 46.8 45 44.5" stroke="#f95225" stroke-width="5" stroke-linecap="round"/><line x1="27" y1="18.5" x2="27" y2="45.5" stroke="#f95225" stroke-width="5" stroke-linecap="round"/></svg>
<h1 style="font-size:1.2rem;margin:.7rem 0 .3rem">Catamorphic server</h1>
<p style="color:#9a9aa3;font-size:.9rem;margin:0">Running. Sign in here or connect from the desktop app or MCP client.</p>
</div>
`;
