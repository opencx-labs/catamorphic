# @catamorphic/codex

`CodexAgent` adapts the pinned OpenAI Codex SDK/CLI to Catamorphic's
`CodingAgentProvider`. It operates on a local checkout on the machine running
the CLI. Register it with `topology: "native"` and supply `nativeAgentCheckout`
in your host. It is not a controller for a remote sandbox.

```ts
import { CodexAgent } from "@catamorphic/codex";

const provider = new CodexAgent({
  codexPathOverride: verifiedCodexExecutable,
  env: { CODEX_HOME: accountHome },
  sandboxMode: "workspace-write",
  mcpServersForSession: sessionTools,
  // Set these when your host provides the corresponding session tools.
  disableNativeSubagents: true,
  disableNativeGoals: true,
});
```

The host creates `accountHome` and owns login or API-key provisioning. Desktop
resolves a verified pinned executable and its PATH sidecars independently of
an installed developer toolchain (ADR 0091). Other hosts may provide their own.
Each turn spawns the CLI with the current working directory, model, effort,
MCP endpoints, credentials, and intersected tool policy. Resume uses the durable
Codex thread id. `interrupt` aborts the active CLI turn.

The default is workspace-write, no interactive approvals, with network access.
Ordinary project files are writable; Codex itself protects `.agents`, `.codex`,
and `.git`. Full access is an explicit host/user choice, never an automatic
fallback after a denied write. A host with project-editing tools can handle
an authorized skill edit through that existing surface.

Project `.agents/skills` are discovered by Codex. Host skill listings and
`read_skill` are injected by the host. Text attachments retain their context;
images use SDK `local_image` inputs, and documents are staged as readable local
files. All staged bytes are removed when the turn ends or startup fails.

MCP `ask` permissions fail closed because this SDK integration has no host
approval-response channel. Connection retries surface as diagnostics; a failed
turn or incomplete stream surfaces as an error. Tests mock SDK events; native
CLI conformance uses a loopback Responses/MCP fixture with a disposable home.
See [ADR 0101](../../docs/decisions/0101-harness-capabilities-and-session-monitors.md).
