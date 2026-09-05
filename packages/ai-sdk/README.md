# @catamorphic/ai-sdk

Minimal coding-agent plugin built on Vercel AI SDK's `ToolLoopAgent`.

The agent loop and model calls run in the host process. Its `read`, `write`,
`edit`, and `bash` tools operate on the project's remote development sandbox
through Catamorphic's vendor-neutral `SandboxProvider` contract. Model
credentials never enter the sandbox.

## Usage

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { AiSdkCodingAgent } from "@catamorphic/ai-sdk";
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import {
  createCatamorphic,
  defineStaticEnvironments,
} from "@catamorphic/server-sdk";

const sandboxProvider = new CloudflareSandboxProvider({
  apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
  apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
});
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
  codingAgent: new AiSdkCodingAgent({
    model: anthropic("claude-sonnet-4-5"),
    sandboxProvider,
    instructions: "Optional host-level system prompt prefix.",
  }),
});
```

The host constructs and injects any AI SDK `LanguageModel`; this package does
not select providers or read model credentials.

## Scope

The implementation deliberately relies on AI SDK's tool loop and message
types. It adds only:

- remote sandbox-backed `read`, `write`, `edit`, and `bash` tools;
- rejection of direct filesystem paths outside the project working directory;
- in-memory multi-turn message history;
- plugin documentation staging and Catamorphic `AgentEvent` mapping.

Project skills remain normal files at `.agents/skills/<name>/SKILL.md`. The
agent is instructed to inspect relevant skills through its filesystem tools.
Provider state remains in memory. After a host restart,
`AgentSessionsService` detects the missing provider anchor and starts a fresh
anchor seeded with the durable Catamorphic transcript; callers continue the
same host session instead of creating a new one.
