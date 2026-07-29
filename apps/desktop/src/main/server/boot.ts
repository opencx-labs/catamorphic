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
import { resolveCodingAgent } from "./coding-agent.js";
import type { DataPaths } from "./paths.js";
import type { DesktopSettings } from "./settings.js";

/** The desktop app is single-tenant: one fixed identity for the machine. */
export const DESKTOP_TENANT_ID = "00000000-0000-4000-8000-00000000d001";
export const DESKTOP_USER_ID = "desktop-user";

export interface EmbeddedServer {
  url: string;
  catamorphic: Catamorphic;
  hasCodingAgent: boolean;
  shutdown: () => Promise<void>;
}

export async function startEmbeddedServer(
  paths: DataPaths,
  settings: DesktopSettings,
): Promise<EmbeddedServer> {
  fs.mkdirSync(paths.db, { recursive: true });

  const pglite = new PGlite(paths.db, { extensions: { pgcrypto } });
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });

  const sandboxProvider = new MicrosandboxSandboxProvider();
  const codingAgent = resolveCodingAgent(settings, sandboxProvider);

  const catamorphic = createCatamorphic({
    database: { db },
    storage: {
      projectsPath: paths.projects,
      remotesPath: paths.remotes,
    },
    sandboxProvider,
    codingAgent,
    appBundleStore: new FsBundleStore(paths.appBundles),
  });

  const { applied } = await catamorphic.migrate();
  if (applied.length > 0) {
    console.log(`[desktop] Applied migrations: ${applied.join(", ")}`);
  }

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
    hasCodingAgent: codingAgent !== undefined,
    shutdown,
  };
}
