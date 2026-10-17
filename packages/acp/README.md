# @catamorphic/acp

The Agent Client Protocol harness adapter for the agent runner (ADRs 0198,
0241). It runs one agent process per attempt from `options.command`, in the
attempt's working directory, and speaks ACP over its stdio: Hermes Agent
(`["hermes", "acp"]`) or any other ACP agent. The agent uses its own
configuration and sign-in.

```ts
import { createAcpAdapter } from "@catamorphic/acp";

const adapters = { acp: createAcpAdapter() };
```

Work's host tools reach the agent as a loopback MCP server for the attempt;
the attempt's own MCP servers pass through. A later turn reopens the agent's
session with `session/load`.

`bun run test` runs the adapter on the real runner against a real ACP agent
process (`src/__tests__/test-agent.mjs`). `bun run test:external` from the
root also runs it against the Hermes on your PATH, with Hermes' own model.
