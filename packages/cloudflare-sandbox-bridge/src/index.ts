/**
 * catamorphic-sandbox-bridge — Cloudflare Worker exposing the Sandbox SDK
 * as an HTTP API the Fastify server (running outside Cloudflare) can call.
 *
 * The heavy lifting lives in `@cloudflare/sandbox/bridge`; this module is a
 * thin wrapper that re-exports the `Sandbox` + `WarmPool` Durable Object
 * classes so Wrangler can wire their bindings.
 *
 * See `CLOUDFLARE.md` at the repo root for decisions + provisioning.
 */

import { bridge } from "@cloudflare/sandbox/bridge";

export { Sandbox } from "@cloudflare/sandbox";
export { WarmPool } from "@cloudflare/sandbox/bridge";

export default bridge({
  async fetch(
    _request: Request,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    return new Response("catamorphic-sandbox-bridge", { status: 200 });
  },

  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Pool priming runs before this handler via the bridge; nothing extra needed.
  },
});
