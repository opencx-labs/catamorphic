# @catamorphic/codex

Coding-agent plugin backed by the OpenAI Codex SDK (`@openai/codex-sdk`).

- **`CodexAgent`** — implements `CodingAgentProvider` (from
  `@catamorphic/sandbox`). Requires `OPENAI_API_KEY` (or Codex CLI auth) in
  the host environment.

Install this package only if you want the Codex agent; the flagship
server-side agent is [`@catamorphic/ai-sdk`](../ai-sdk/README.md). See
`docs/decisions/0009` for the pluggable coding-agent architecture.

## Usage

```ts
import { CodexAgent } from "@catamorphic/codex";
import {
  createCatamorphic,
  defineStaticEnvironments,
} from "@catamorphic/server-sdk";

const environmentProvider = defineStaticEnvironments([
  {
    descriptor: {
      id: "local",
      label: "Managed execution",
      trust: "managed",
      isolation: "sandbox",
      workloads: ["agent", "workflow"],
      agentTopologies: ["controller"],
      capabilities: ["network.egress"],
      resources: {},
    },
    sandboxProvider,
  },
]);

const catamorphic = createCatamorphic({
  hostId: "my-host",
  database: { connectionString: process.env.DATABASE_URL! },
  storage: { projectManager },
  sandboxProvider,
  environmentProvider,
  codingAgent: new CodexAgent(),
});
```

This one-provider form is wrapped as a controller registry entry. A host that
wants Codex to operate directly on a local checkout should register it with
`topology: "native"` in a `CodingAgentRegistry` and provide
`nativeAgentCheckout`.
