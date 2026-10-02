# @catamorphic/ai-sdk

The built-in agent: Vercel AI SDK's tool loop as a harness adapter
(`HarnessAdapter`, ADR 0197) with the id `ai-sdk`. It always runs in the
host's own process (the desktop, the control plane) through an in-process
agent runner. Model calls run in the host; the `read`, `write`, `edit` and
shell tools run on the session's sandbox through the vendor-neutral
`SandboxProvider` contract. Model credentials never enter the sandbox.

## Usage

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { createAiSdkAdapter, type AiSdkLocal } from "@catamorphic/ai-sdk";
import { InProcessRunner } from "@catamorphic/agent-runner";

const adapter = createAiSdkAdapter({
  model: anthropic("claude-sonnet-4-5"),
  resolveModel: (id) => anthropic(id), // enables per-attempt model overrides
  effort: "medium",
  instructions: "Optional host-level instructions.",
});

const local: AiSdkLocal = {
  sandbox: { provider: sandboxProvider, sandboxId, workingDirectory },
  readableRoots: [pastedFilesDirectory],
  shell: chatShellState, // kept by the host across a chat's attempts
};
const runner = new InProcessRunner({
  adapters: { [adapter.id]: adapter },
  version,
  local,
});
runner.send({ id: commandId, command: { kind: "start", attempt } });
```

The host constructs the `LanguageModel`; this package never selects
providers or reads model credentials. Everything per turn arrives in the
`AttemptStart`: model and effort overrides, the system prompt, turn context,
input, MCP servers and their tool policies, host tools, plugins.

## What it does

- Streams assistant text and reasoning as items, shell commands as
  `command` items, file writes and edits as `file_change` items, and MCP and
  host tools as `tool_call` items; reasoning headings become the live status.
- Asks questions (`ask_user`), approvals (policed MCP servers) and MCP
  elicitations as runtime requests through the host.
- Takes steered input before its next model step, and stops on interrupt.
- Stores its native thread, the AI SDK message history, with Work one step
  at a time (`nativeState: "store"`), so a later turn resumes on any
  replica or after a restart. A native retry (`input: null`) re-runs the
  last turn on that history, and a fork copies a thread through a turn.

## Tests

`@catamorphic/ai-sdk/testing` replays recorded model transcripts (the
provider's stream parts, call by call) as a `LanguageModel`, so tests
replace only the model transport. `recordModel` captures a transcript from
a live model; `replyCall`, `toolCallsCall`, `rejectedCall` and friends
write one by hand.

```ts
import { replayModel, replyCall, toolCallsCall } from "@catamorphic/ai-sdk/testing";

const replay = replayModel({
  calls: [
    toolCallsCall([{ id: "c1", name: "bash", input: { command: "ls" } }]),
    replyCall("Listed."),
  ],
});
const adapter = createAiSdkAdapter({ model: replay.model });
// ...drive a real runner and host; replay.calls holds what the model saw.
```
