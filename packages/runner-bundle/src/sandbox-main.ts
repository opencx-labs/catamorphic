/**
 * The entry point of the runner bundle a sandbox runs (ADR 0197):
 * `bun runner.mjs` or `node runner.mjs`. Every harness that runs beside its
 * workspace is here.
 */
import {
  AGENT_RUNNER_VERSION,
  EchoAdapter,
  runStdioRunner,
} from "@catamorphic/agent-runner";
import { createClaudeCodeAdapter } from "@catamorphic/claude-code";
import { createCodexAdapter } from "@catamorphic/codex";

await runStdioRunner({
  adapters: {
    "claude-code": createClaudeCodeAdapter(),
    codex: createCodexAdapter(),
    echo: new EchoAdapter(),
  },
  version: AGENT_RUNNER_VERSION,
});
process.exit(0);
