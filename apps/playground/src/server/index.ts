/**
 * Playground host server.
 *
 * This is a reference *host application* for catamorphic — the kind of
 * backend an embedding SaaS product would write. It demonstrates the
 * Cloudflare-first setup:
 *
 *   - Cloudflare Sandbox (via the Bridge Worker) for workflow execution and
 *     dev sandboxes
 *   - Cloudflare Artifacts as the canonical git storage for project code
 *   - Postgres (schema-scoped) for catamorphic state
 *   - `@catamorphic/fastify-plugin` mounted at `/api`
 *
 * Identity: a real host derives tenant/user from its auth session. The
 * playground plays that role with fixed demo identity injected server-side.
 */

import { catamorphicPlugin } from "@catamorphic/fastify-plugin";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { bootCatamorphic, DEMO_TENANT_ID, DEMO_USER_ID } from "./boot.js";

const PORT = Number(process.env.PLAYGROUND_SERVER_PORT ?? 8500);

const catamorphic = await bootCatamorphic();

const app = Fastify({ logger: { level: "info" } });

await app.register(cors, {
  origin: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});

// The playground is single-tenant: inject the demo identity on every request
// the way a real host would inject identity from its verified session.
app.addHook("onRequest", async (request) => {
  request.headers["x-catamorphic-tenant-id"] ??= DEMO_TENANT_ID;
  request.headers["x-external-user-id"] ??= DEMO_USER_ID;
});

await app.register(catamorphicPlugin, {
  core: catamorphic.core,
  prefix: "/api",
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`[playground] API ready on http://localhost:${PORT}/api`);
