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
session with `session/load` when the agent offers it (its replay proves the
session is there), else `session/resume`; a session the agent no longer has
is reported gone (`thread.lost`, ADR 0245), and Work runs the turn again on
a new one, handed the conversation. A crash, a sign-in, a session the agent
still lists or a passing error fails the turn and leaves the session to the
next one.
A turn ends once the agent's process has exited, so a session it saves on
exit is saved before the next turn reopens it.

`bun run test` runs the adapter on the real runner against a real ACP agent
process (`src/__tests__/test-agent.mjs`). `bun run test:external` from the
root also runs it against the Hermes on your PATH, with Hermes' own model.
