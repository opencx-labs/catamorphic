import { createApp } from "./app.js";

const app = createApp();

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`Received ${signal}, shutting down gracefully...`);
  try {
    await app.close();
  } catch (err) {
    app.log.error(err, "Error during shutdown");
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await app.ready();
  await app.listen({ port: 3001, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err, "Failed to start server");
  process.exit(1);
}
