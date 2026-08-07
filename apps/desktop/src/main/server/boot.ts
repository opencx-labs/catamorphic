import fs from "node:fs";
import type { DB } from "@catamorphic/db";
import { DEFAULT_SCHEMA } from "@catamorphic/db";
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";
import { MicrosandboxSandboxProvider } from "@catamorphic/microsandbox";
import {
  type Catamorphic,
  createCatamorphic,
  FsBundleStore,
} from "@catamorphic/server-sdk";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import type { WorkspaceBridge } from "../agent-bridge.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { ProfilesStore } from "../profiles.js";
import { DesktopAgentRegistry } from "./agent-registry.js";
import { E2eLocalSandboxProvider } from "./e2e-fakes.js";
import { FileGithubTokenStore, GITHUB_APP } from "./github.js";
import type { DataPaths } from "./paths.js";
import { ProjectRootsStore } from "./project-roots.js";

/** The desktop app is single-tenant: one fixed identity for the machine. */
export const DESKTOP_TENANT_ID = "00000000-0000-4000-8000-00000000d001";
export const DESKTOP_USER_ID = "desktop-user";

export interface EmbeddedServer {
  url: string;
  catamorphic: Catamorphic;
  projectRoots: ProjectRootsStore;
  /** Dynamic roster of configured agents (per-profile agents.json files). */
  agentRegistry: DesktopAgentRegistry;
  hasCodingAgent: boolean;
  shutdown: () => Promise<void>;
}

export async function startEmbeddedServer(
  paths: DataPaths,
  profiles: ProfilesStore,
  profileConfig: ProfileConfigManager,
  workspaceBridge?: WorkspaceBridge,
): Promise<EmbeddedServer> {
  fs.mkdirSync(paths.db, { recursive: true });

  const pglite = new PGlite(paths.db, { extensions: { pgcrypto } });
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });

  // E2E runs swap the real sandbox + agents for deterministic local fakes.
  const e2eFakeAgent = process.env.CATAMORPHIC_E2E_FAKE_AGENT === "1";
  const sandboxProvider = e2eFakeAgent
    ? new E2eLocalSandboxProvider()
    : new MicrosandboxSandboxProvider();

  // Agents resolve dynamically from the per-profile agents.json files, so
  // adding or editing an agent in Settings needs no server restart. In e2e
  // mode the default profile is seeded with two fake-backed agents so the
  // renderer's agent flows (lists, switching, effort) run for real.
  const agentRegistry = new DesktopAgentRegistry({
    profiles,
    profileConfig,
    sandboxProvider,
    agentHomesDir: paths.agentHomesDir,
    e2eFake: e2eFakeAgent,
    workspaceBridge,
  });
  if (e2eFakeAgent) {
    const agents = profileConfig.forDefaultProfile().agents;
    if (agents.list().length === 0) {
      agents.create({ name: "Fake Agent", harness: "ai-sdk" });
      agents.create({ name: "Other Fake", harness: "ai-sdk" });
    }
  }

  // Desktop projects live in user-visible folders; the mapping is desktop
  // state (its own PGlite schema), injected into storage as a resolver so
  // the shared catamorphic schema never learns about filesystem paths.
  const projectRoots = new ProjectRootsStore(pglite);
  await projectRoots.init();

  const catamorphic = createCatamorphic({
    database: { db },
    storage: {
      projectsPath: paths.projects,
      remotesPath: paths.remotes,
      projectPathResolver: (_tenantId, projectId) =>
        projectRoots.get(projectId),
    },
    sandboxProvider,
    codingAgent: agentRegistry,
    // Host-execution agents (Claude Code, Codex) run right in the project's
    // user-visible folder.
    hostProjectPathResolver: async (projectId) =>
      (await projectRoots.get(projectId)) ?? undefined,
    appBundleStore: new FsBundleStore(paths.appBundles),
    github: {
      app: GITHUB_APP,
      tokenStore: new FileGithubTokenStore(paths.githubFile),
    },
  });

  const { applied } = await catamorphic.migrate();
  if (applied.length > 0) {
    console.log(`[desktop] Applied migrations: ${applied.join(", ")}`);
  }

  // The workspace toolkit's read_tab expands chat tabs into transcripts;
  // the chat store only exists from here on.
  agentRegistry.workspaceToolkit?.setChatTranscriptReader(
    async (projectId, sessionId) => {
      const detail = await catamorphic.core.agentSessions?.get(
        { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
        projectId,
        sessionId,
      );
      if (!detail) return null;
      return {
        title: detail.title ?? null,
        messages: detail.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
    },
  );

  const app: FastifyInstance = Fastify({ logger: { level: "warn" } });
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  app.addHook("onRequest", async (request) => {
    request.headers["x-catamorphic-tenant-id"] ??= DESKTOP_TENANT_ID;
    request.headers["x-external-user-id"] ??= DESKTOP_USER_ID;
  });
  await app.register(catamorphicPlugin, {
    core: catamorphic.core,
    prefix: "/api",
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Embedded server bound to an unexpected address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`[desktop] API ready on ${url}/api`);

  // PGlite is a single serialized connection; more worker concurrency would
  // only queue on the connection mutex.
  const worker = catamorphic.startExecutionWorker({
    name: "desktop",
    concurrency: 1,
  });

  let shutdownDone: Promise<void> | undefined;
  const shutdown = () => {
    shutdownDone ??= (async () => {
      await worker.stop().catch(() => {});
      await app.close().catch(() => {});
      await catamorphic.close().catch(() => {});
      // catamorphic.close() leaves the host-owned Kysely alone; destroying it
      // closes the PGlite instance (flushes WAL to the data dir).
      await db.destroy().catch(() => {});
    })();
    return shutdownDone;
  };

  return {
    url,
    catamorphic,
    projectRoots,
    agentRegistry,
    get hasCodingAgent() {
      return agentRegistry.hasAgents();
    },
    shutdown,
  };
}
