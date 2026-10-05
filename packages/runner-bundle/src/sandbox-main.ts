/**
 * The entry point of the runner bundle a sandbox runs (ADR 0198):
 * `bun runner.mjs` or `node runner.mjs`. Every harness that runs beside its
 * workspace is here.
 */
import type { HarnessAdapter } from "@catamorphic/agent-protocol/runner";
import {
  AGENT_RUNNER_VERSION,
  EchoAdapter,
  readEnvFile,
  runStdioRunner,
} from "@catamorphic/agent-runner";
import { createClaudeCodeAdapter } from "@catamorphic/claude-code";
import { createCodexAdapter } from "@catamorphic/codex";
import {
  parseSandboxPaths,
  remapPaths,
  SANDBOX_PATHS_ENV,
} from "@catamorphic/sandbox";
import { withSandboxPaths } from "./sandbox-paths.js";

const adapters: Record<string, HarnessAdapter> = {
  "claude-code": createClaudeCodeAdapter(),
  codex: createCodexAdapter(),
  echo: new EchoAdapter(),
};
// A process sandbox hands out virtual paths and says where they really are.
const paths = parseSandboxPaths(process.env[SANDBOX_PATHS_ENV]);

await runStdioRunner({
  adapters: paths
    ? Object.fromEntries(
        Object.entries(adapters).map(([id, adapter]) => [
          id,
          withSandboxPaths(adapter, paths),
        ]),
      )
    : adapters,
  version: AGENT_RUNNER_VERSION,
  // The session's environment file (ADR 0205), where it really is.
  envFile: (file) =>
    readEnvFile(paths ? remapPaths(file, paths.virtual, paths.real) : file),
});
process.exit(0);
