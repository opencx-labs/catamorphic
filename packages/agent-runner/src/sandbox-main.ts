/**
 * The entry point of the runner bundle a sandbox runs (ADR 0196):
 * `bun runner.mjs` or `node runner.mjs`. Every harness that runs beside its workspace is here.
 */
import { createCodexAdapter } from "@catamorphic/codex";
import { EchoAdapter } from "./echo-adapter.js";
import { AGENT_RUNNER_VERSION } from "./index.js";
import { runStdioRunner } from "./stdio.js";

await runStdioRunner({
  adapters: {
    codex: createCodexAdapter(),
    echo: new EchoAdapter(),
  },
  version: AGENT_RUNNER_VERSION,
});
process.exit(0);
