# @catamorphic/codex

`CodexAgent` adapts the pinned OpenAI Codex app-server protocol to Catamorphic's
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
Each host session retains a native app-server process and its MCP children across
turns. Current cwd, model, effort, and developer context refresh each turn. Changed
MCP configuration or policy restarts the process and resumes the durable thread ID.
Five idle minutes release the process; the next turn resumes with fresh MCP state.
`interrupt` interrupts the native turn, and disposal closes its process and gateway.

The default is workspace-write, no interactive approvals, with network access.
Ordinary project files are writable; Codex itself protects `.agents`, `.codex`,
and `.git`. Full access is an explicit host/user choice, never an automatic
fallback after a denied write. A host with project-editing tools can handle
an authorized skill edit through that existing surface.

Project `.agents/skills` are discovered by Codex. Host skill listings and
`read_skill` are injected by the host. Text attachments retain their context;
images use SDK `local_image` inputs, and documents are staged as readable local
files. All staged bytes are removed when the turn ends or startup fails.

Supply `mcpElicitationForSession` to create a form/URL request handler per native
session lifetime and `onToolPermission` for native
command/file approvals. With either handler enabled, native approval policy is
`on-request`; absent callbacks decline requests. MCP tool-level `ask` filters
still fail closed; native elicitation is a separate service permission mechanism. Connection retries surface as diagnostics; a failed
turn or incomplete stream surfaces as an error. Tests cover normalized events; native
CLI conformance uses a loopback Responses/MCP fixture with a disposable home.
See [ADR 0101](../../docs/decisions/0101-harness-capabilities-and-session-monitors.md).

The desktop's optional Codex Computer Use connector references the user's installed
native plugin. The CLI/SDK alone does not include OS control. See the desktop
[browser and computer-use contract](../../apps/desktop/docs/computer-use.md) and
[ADR 0112](../../docs/decisions/0112-browser-control-and-tool-media.md).
