# @catamorphic/codex

Coding-agent plugin backed by the OpenAI Codex SDK (`@openai/codex-sdk`).

- **`CodexAgent`** — implements `CodingAgentProvider` (from
  `@catamorphic/sandbox`). Requires `OPENAI_API_KEY` (or Codex CLI auth) in
  the host environment.

Install this package only if you want the Codex agent; the flagship
server-side agent is [`@catamorphic/flue`](../flue/README.md). See
`docs/decisions/0009` for the pluggable coding-agent architecture.

## Usage

```ts
import { CodexAgent } from "@catamorphic/codex";
import { createCatamorphic } from "@catamorphic/server-sdk";

const catamorphic = createCatamorphic({
  database: { connectionString: process.env.DATABASE_URL! },
  storage: { projectManager },
  sandboxProvider,
  codingAgent: new CodexAgent(),
});
```
