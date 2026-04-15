import { createDatabase } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { DaytonaSandboxProvider } from "@catamorphic/sandbox";
import { createApp } from "./app.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://catamorphic:catamorphic@localhost:5432/catamorphic";

const PROJECTS_PATH = process.env.PROJECTS_PATH ?? "/tmp/catamorphic-projects";

const db = createDatabase({ connectionString: DATABASE_URL });
const projectManager = new ProjectManager(new FsBackend(PROJECTS_PATH));

const sandboxProvider = process.env.DAYTONA_API_KEY
  ? new DaytonaSandboxProvider({ apiKey: process.env.DAYTONA_API_KEY })
  : undefined;

const app = createApp({ db, projectManager, sandboxProvider });

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`Received ${signal}, shutting down gracefully...`);
  try {
    await app.close();
    await db.destroy();
  } catch (err) {
    app.log.error(err, "Error during shutdown");
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const PORT = Number(process.env.PORT ?? 3001);

try {
  await app.ready();
  await app.listen({ port: PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err, "Failed to start server");
  process.exit(1);
}
