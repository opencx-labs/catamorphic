import fs from "node:fs";
import path from "node:path";
import { type Identity, ToolPermissionBroker } from "@catamorphic/core";
import { type DB, DEFAULT_SCHEMA } from "@catamorphic/db";
import { createApp, identityFromBearer } from "@catamorphic/fastify-plugin";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import {
  type Catamorphic,
  createCatamorphic,
  FsBundleStore,
} from "@catamorphic/server-sdk";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { ASSISTANT_SLUG, buildAgentRegistry } from "./agents.js";
import { AuthStore, type TokenRecord } from "./auth-store.js";

/**
 * The stock Catamorphic server (ADR 0059): everything on disk under one
 * data dir, zero external services. PGlite for the database, bare git
 * repos for project origins, local-process execution (the container IS
 * the sandbox — single-tenant only, per ADR 0047), bearer tokens in a
 * JSON file, invites minted over an admin API.
 */

/** Single-tenant, like the desktop: one fixed tenant for the machine. */
export const SERVER_TENANT_ID = "00000000-0000-4000-8000-0000000005e1";

const ROOT_USER = "admin";

export interface StockServerOptions {
  dataDir: string;
  /** Public bases (no trailing slash) invite links are minted against. */
  publicBases?: string[];
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface StockServer {
  app: FastifyInstance;
  catamorphic: Catamorphic;
  auth: AuthStore;
  agentsDescription: string;
  /** Build a connect link for a token against a public API base. */
  connectLink(base: string, record: TokenRecord, projectName?: string): string;
  shutdown(): Promise<void>;
}

const MEMBER_ROLE_PATH = "roles/member.json";
const MEMBER_ROLE = {
  version: 1,
  name: "Member",
  description: "Chat with the assistant; a private store folder.",
  agents: [ASSISTANT_SLUG],
  documents: [{ path: "store/users/{user}/**", access: "write" as const }],
};

export async function buildStockServer(
  options: StockServerOptions,
): Promise<StockServer> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const data = options.dataDir;
  for (const dir of ["db", "projects", "remotes", "app-bundles", "sandboxes"]) {
    fs.mkdirSync(path.join(data, dir), { recursive: true });
  }

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

  // Tool-permission asks park here; clients answer over HTTP (ADR 0054).
  const toolPermissions = new ToolPermissionBroker();
  const agents = buildAgentRegistry({ sandboxProvider, toolPermissions, env });

  const catamorphic = createCatamorphic({
    database: databaseConfig,
    storage: {
      projectsPath: path.join(data, "projects"),
      remotesPath: path.join(data, "remotes"),
    },
    sandboxProvider,
    ...(agents.registry ? { codingAgent: agents.registry } : {}),
    appBundleStore: new FsBundleStore(path.join(data, "app-bundles")),
    toolPermissions,
  });
  await catamorphic.migrate();
  // PGlite is a single serialized connection: one worker lane there;
  // real Postgres gets a few.
  const worker = catamorphic.startExecutionWorker({
    name: "stock-server",
    concurrency: workerConcurrency,
  });
  const core = catamorphic.core;

  const auth = new AuthStore(path.join(data, "auth.json"));
  const admin = auth.ensureAdmin();
  const rootIdentity: Identity = {
    tenantId: SERVER_TENANT_ID,
    externalUserId: ROOT_USER,
  };

  // --- HTTP: the standard API app + the server's own routes -----------
  const app = createApp({
    core,
    identity: identityFromBearer(async (token) => {
      const record = auth.findByToken(token);
      if (!record) return null;
      if (record.kind === "admin") return rootIdentity;
      if (!record.projectId) return null;
      // Access is the membership's, not the token's: revoking the
      // membership (or its roles) cuts the member off instantly.
      return core.memberships.identityFor({
        tenantId: SERVER_TENANT_ID,
        projectId: record.projectId,
        externalUserId: record.externalUserId,
      });
    }),
    features: { publications: "members" },
  });

  const requireAdmin = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): boolean => {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(
      Array.isArray(header) ? (header[0] ?? "") : header,
    );
    const record = match?.[1] ? auth.findByToken(match[1]) : undefined;
    if (record?.kind === "admin") return true;
    void reply.status(401).send({ error: "Admin token required" });
    return false;
  };

  app.get("/healthz", async () => ({
    ok: true,
    agentSessions: Boolean(core.agentSessions),
  }));

  // The mobile PWA, served from THIS origin (workspace sibling in dev,
  // CATAMORPHIC_PWA_DIST in the Docker image). Serving it here is what
  // makes phones work AWAY from any LAN: invite links can point at
  // `https://server/?server=…&token=…`, the app installs from a stable
  // (ideally https) origin, and its service worker caches the shell.
  // Without a bundle, a minimal landing page answers instead.
  const pwaDist =
    env.CATAMORPHIC_PWA_DIST ??
    path.resolve(import.meta.dirname, "../../pwa/dist");
  app.get("/*", async (request, reply) => {
    if (!fs.existsSync(path.join(pwaDist, "index.html"))) {
      return reply.type("text/html").send(LANDING_PAGE);
    }
    const requested = decodeURIComponent(
      (request.url.split("?")[0] ?? "/").replace(/^\/+/, ""),
    );
    const resolved = path.resolve(pwaDist, requested || "index.html");
    const file =
      resolved.startsWith(pwaDist) &&
      fs.existsSync(resolved) &&
      fs.statSync(resolved).isFile()
        ? resolved
        : path.join(pwaDist, "index.html");
    return reply
      .type(
        STATIC_CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      )
      .send(fs.readFileSync(file));
  });

  app.post("/admin/projects", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as { name?: string };
    if (!body.name?.trim()) {
      return reply.status(400).send({ error: "A project needs a name" });
    }
    const project = await core.projects.create(rootIdentity, {
      name: body.name.trim(),
    });
    return reply.status(201).send(project);
  });

  /**
   * Mint an invite: ensure the committed member role on the project's
   * shared program, grant the membership, mint a bearer token. The
   * response carries connect links for every address this server answers
   * on — the caller forwards one to the invitee.
   */
  app.post("/admin/invites", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as {
      projectId?: string;
      user?: string;
      label?: string;
    };
    const projectId = body.projectId?.trim();
    const user = body.user?.trim();
    if (!projectId || !user) {
      return reply
        .status(400)
        .send({ error: "projectId and user are required" });
    }
    const project = await core.projects
      .get(rootIdentity, projectId)
      .catch(() => null);
    if (!project) {
      return reply.status(404).send({ error: "No such project" });
    }
    await ensureMemberRole(projectId);
    await core.memberships.grant({
      identity: rootIdentity,
      projectId,
      externalUserId: user,
      roles: ["member"],
      grants: { user: [user] },
    });
    const record = auth.mintMember(user, projectId, body.label);
    return reply.status(201).send({
      token: record.token,
      user,
      projectId,
      projectName: project.name,
      connectLinks: (options.publicBases ?? []).map((base) =>
        buildConnectLink(base, record, project.name),
      ),
      // The same credentials as a plain URL: opens the PWA this server
      // serves at its root — the link to text someone.
      webLinks: (options.publicBases ?? []).map(
        (base) =>
          `${base.replace(/\/+$/, "")}/?${connectParams(base, record, project.name)}`,
      ),
    });
  });

  app.delete("/admin/invites/:token", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { token } = request.params as { token: string };
    const record = auth.findByToken(token);
    if (record?.kind !== "member") {
      return reply.status(404).send({ error: "No such member token" });
    }
    auth.revoke(token);
    return reply.send({ ok: true });
  });

  /** The committed member role, deployed to origin main exactly once. */
  const ensuredRoles = new Set<string>();
  async function ensureMemberRole(projectId: string): Promise<void> {
    if (ensuredRoles.has(projectId)) return;
    const existing = await core.documents
      .read({ identity: rootIdentity, projectId, path: MEMBER_ROLE_PATH })
      .catch(() => null);
    if (!existing) {
      await core.deployment.deploy(SERVER_TENANT_ID, projectId, ROOT_USER, {
        message: "Add the member role",
        files: {
          [MEMBER_ROLE_PATH]: `${JSON.stringify(MEMBER_ROLE, null, 2)}\n`,
        },
      });
      core.roles.invalidate(projectId);
    }
    ensuredRoles.add(projectId);
  }

  log(`agents: ${agents.description}`);
  log(`admin token: ${admin.token} (data: ${path.join(data, "auth.json")})`);

  return {
    app,
    catamorphic,
    auth,
    agentsDescription: agents.description,
    connectLink: buildConnectLink,
    shutdown: async () => {
      await worker.stop();
      await app.close();
      // For DATABASE_URL, close() also destroys the pool it created; the
      // host-owned PGlite Kysely is ours to flush.
      await catamorphic.close();
      await ownDb?.destroy();
    },
  };
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function connectParams(
  base: string,
  record: TokenRecord,
  projectName?: string,
): string {
  const server = `${base.replace(/\/+$/, "")}/api`;
  const params = new URLSearchParams({
    server,
    token: record.token,
    project: record.projectId ?? "",
  });
  if (projectName) params.set("name", projectName);
  return params.toString();
}

function buildConnectLink(
  base: string,
  record: TokenRecord,
  projectName?: string,
): string {
  return `catamorphic://connect?${connectParams(base, record, projectName)}`;
}

const LANDING_PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Catamorphic server</title>
<body style="margin:0;display:grid;place-items:center;min-height:100dvh;background:#0a0a0b;color:#e6e6e9;font-family:system-ui">
<div style="text-align:center;padding:2rem">
<svg width="72" height="72" viewBox="0 0 64 64" fill="none"><path d="M45 19.5 C41.7 17.2 37.6 15.8 33.5 15.8 C24 15.8 16.5 23 16.5 32 C16.5 41 24 48.2 33.5 48.2 C37.6 48.2 41.7 46.8 45 44.5" stroke="#f95225" stroke-width="5" stroke-linecap="round"/><line x1="27" y1="18.5" x2="27" y2="45.5" stroke="#f95225" stroke-width="5" stroke-linecap="round"/></svg>
<h1 style="font-size:1.2rem;margin:.7rem 0 .3rem">Catamorphic server</h1>
<p style="color:#9a9aa3;font-size:.9rem;margin:0">Running. API at <code>/api</code>, docs at <code>/docs</code>.<br>Connect with an invite link from your admin.</p>
</div>
`;
