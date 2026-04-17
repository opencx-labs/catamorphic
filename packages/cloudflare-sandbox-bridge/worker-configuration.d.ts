// Minimal, hand-written version of the file Wrangler normally generates via
// `wrangler types`. Regenerate with `bun run cf-typegen` once you have local
// Wrangler authenticated; until then, this keeps `tsgo` typecheck green.
//
// Matches the bindings declared in wrangler.jsonc.

declare global {
  interface Env {
    SANDBOX_API_KEY?: string;
    WARM_POOL_TARGET: string;
    WARM_POOL_REFRESH_INTERVAL: string;
    Sandbox: DurableObjectNamespace;
    WarmPool: DurableObjectNamespace;
  }
}

export {};
