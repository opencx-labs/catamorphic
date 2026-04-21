import { createDatabase } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { LocalPluginResolver, type PluginResolver } from "@catamorphic/plugins";
import {
  CloudflareSandboxProvider,
  DaytonaSandboxProvider,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { createApp } from "./app.js";
import { AgentContextService } from "./services/agent-context-service.js";
import { PluginsService } from "./services/plugins-service.js";
import { RunPluginsLoader } from "./services/run-plugins-loader.js";
import { SecretsService } from "./services/secrets-service.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://catamorphic:catamorphic@localhost:5432/catamorphic";
const CATAMORPHIC_DB_SCHEMA =
  process.env.CATAMORPHIC_DB_SCHEMA ?? "catamorphic";

const PROJECTS_PATH = process.env.PROJECTS_PATH ?? "/tmp/catamorphic-projects";
const REMOTES_PATH =
  process.env.REMOTES_PATH ?? "/tmp/catamorphic-project-remotes";

const db = createDatabase({
  connectionString: DATABASE_URL,
  schema: CATAMORPHIC_DB_SCHEMA,
});
const projectManager = new ProjectManager(
  new FsBackend(PROJECTS_PATH),
  new FsRemoteBackend(REMOTES_PATH),
);

function resolveSandboxProvider(): SandboxProvider | undefined {
  // Cloudflare is the default when both the bridge URL and shared key are
  // configured; Daytona is the fallback. See CLOUDFLARE.md.
  const cfUrl = process.env.CLOUDFLARE_SANDBOX_API_URL;
  const cfKey = process.env.CLOUDFLARE_SANDBOX_API_KEY;
  if (cfUrl && cfKey) {
    return new CloudflareSandboxProvider({ apiUrl: cfUrl, apiKey: cfKey });
  }

  if (process.env.DAYTONA_API_KEY) {
    return new DaytonaSandboxProvider({
      apiKey: process.env.DAYTONA_API_KEY,
    });
  }

  return undefined;
}

const sandboxProvider = resolveSandboxProvider();

function resolvePluginResolver(): PluginResolver | undefined {
  const rootDir = process.env.CATAMORPHIC_LOCAL_PLUGINS_DIR;
  if (!rootDir) return undefined;
  return new LocalPluginResolver({ rootDir });
}

const pluginResolver = resolvePluginResolver();
const pluginsService = pluginResolver
  ? new PluginsService(db, pluginResolver)
  : undefined;
const secretsService = pluginsService
  ? new SecretsService(db, pluginsService)
  : undefined;
const runPluginsLoader =
  pluginResolver && pluginsService && secretsService
    ? new RunPluginsLoader(pluginsService, secretsService, pluginResolver)
    : undefined;
const agentContextService =
  pluginResolver && pluginsService
    ? new AgentContextService(pluginsService, pluginResolver)
    : undefined;

const app = createApp({
  db,
  projectManager,
  sandboxProvider,
  pluginsService,
  secretsService,
  runPluginsLoader,
  agentContextService,
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`Received ${signal}, shutting down gracefully...`);
  const forceExit = setTimeout(() => {
    app.log.error("Graceful shutdown timed out after 5s; forcing exit.");
    process.exit(1);
  }, 5000);
  forceExit.unref();

  try {
    await app.close();
    await db.destroy();
  } catch (err) {
    app.log.error(err, "Error during shutdown");
  }
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => shutdown(signal));
}

const PORT = Number(process.env.PORT ?? 3001);

try {
  await app.ready();
  await app.listen({ port: PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err, "Failed to start server");
  process.exit(1);
}
