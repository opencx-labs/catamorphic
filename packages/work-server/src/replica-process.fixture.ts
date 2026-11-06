/**
 * A Work server replica in its own process, configured from the environment
 * like the image, for tests that crash it with SIGKILL (ADR 0190). It prints
 * one JSON line with its machine id once it is up, then runs until killed.
 */
import { workServerConfigFromEnv } from "./config.js";
import { createWorkServer } from "./server.js";

const server = await createWorkServer({
  config: workServerConfigFromEnv(process.env),
});
await server.app.listen({ port: 0, host: "127.0.0.1" });
const health = await server.app.inject({ method: "GET", url: "/healthz" });
process.stdout.write(`${JSON.stringify({ node: health.json().machine.id })}\n`);
