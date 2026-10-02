# @catamorphic/codex

The Codex harness adapter (`codex`) for the agent runner (ADR 0197). It runs
one pinned `codex app-server` process per attempt, beside the workspace it
edits: inside the session's sandbox on a server (in the runner bundle), or
in the host's own process on the desktop.

```ts
import { createCodexAdapter } from "@catamorphic/codex";

const adapters = { codex: createCodexAdapter() };
```

The adapter takes no per-agent settings. Everything arrives with each
`AttemptStart`:

- `options`: `command` (the `codex` executable, default `codex`),
  `disableNativeSubagents`, `disableNativeGoals`, `networkAccess` (default
  true) and `config` (extra Codex `-c` overrides, merged last).
- `permissions`: Codex's own `sandbox` (`read-only`, `workspace-write`,
  `danger-full-access`) and `approvals` (`untrusted`, `on-failure`,
  `on-request`, `never`). The sandbox defaults to `workspace-write` with
  `modelAccess: host` and to `danger-full-access` elsewhere, where the Work
  sandbox is the boundary. Approvals default to `on-request`.
- `modelAccess`: `gateway` is the `work` model provider (Responses API, a
  key command reading `keyFile`) with `CODEX_HOME` in the state directory;
  `sign_in` runs with `CODEX_HOME` at the member's own home (ADR 0198);
  `host` runs Codex as the host configured it (`env`, including an optional
  `CODEX_API_KEY`).
- `mcpServers` become Codex `mcp_servers`. A server with a tool policy asks
  before every call (`default_tools_approval_mode = prompt`), and the
  runner decides the ask by the policy, opening an approval only for `ask`.
- `hostTools` are Codex dynamic tools; a call is a host call.
- `systemPrompt` (and installed `plugins`) become developer instructions;
  `context` rides `turn/start.additionalContext`.

Codex's structured questions (`request_user_input`), command, file and
permission approvals, and MCP elicitations are runtime requests. A steer is
`turn/steer` into the running turn; an interrupt is `turn/interrupt`.

Native state is the thread's rollout file (`nativeState: "file"`): the
adapter mirrors its new lines to Work as they appear, restores them into a
fresh `CODEX_HOME` to resume elsewhere, and keeps a fork's ancestors'
rollouts with the fork, since a fork's history starts in its source's file.

## Tests replay real transcripts

`fixtures/replay/*.json` are recorded from the pinned CLI against a
scripted loopback Responses API (`bun run record:codex-replay [scenario]`;
scenarios live in `src/__tests__/replay/scenarios.ts`). The replay peer in
`@catamorphic/codex/testing` replaces only the app-server process: every
frame the adapter sends must match the transcript in order, and recorded
frames and rollout writes are served in their recorded order around them.

```ts
import { createCodexAdapter } from "@catamorphic/codex";
import { CodexReplay, loadCodexFixture } from "@catamorphic/codex/testing";

const replay = new CodexReplay(await loadCodexFixture("simple-reply"), {
  placeholders: { root, model, node, fixtures },
});
const adapter = createCodexAdapter({ transport: replay.transport });
// Run the scenario's attempts through a runner, then:
await replay.verify();
```

`listCodexModels`, `resolveCodexModel` and `listCodexSkills` read the CLI's
catalogs without a model turn.
