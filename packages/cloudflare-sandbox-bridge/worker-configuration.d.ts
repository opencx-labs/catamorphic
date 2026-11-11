// Minimal, hand-written version of the file Wrangler normally generates via
// `wrangler types`. These are the bindings the bridge consumes; no account
// access is needed to maintain this declaration.
//
// Matches the bindings declared in wrangler.jsonc.

declare global {
  interface Env {
    SANDBOX_API_KEY?: string;
    NativeSandbox: DurableObjectNamespace<import("./src/index.js").NativeSandbox>;
  }
}

export {};
