# @catamorphic/flue

Coding-agent plugin backed by the [Flue](https://flueframework.com) agent
framework. This is catamorphic's flagship coding agent (see
`docs/decisions/0009`):

- **`FlueCodingAgent`** — implements `CodingAgentProvider` (from
  `@catamorphic/sandbox`). The Flue harness runs **in the host server
  process**; every file edit and shell command executes remotely inside the
  per-(project, user) dev sandbox. Model API keys never enter the sandbox.
- **`catamorphicSandbox`** — a Flue `SandboxFactory` implemented over any
  catamorphic `SandboxProvider` (Cloudflare, Daytona, or host-supplied).
- Re-exports Flue's `defineSkill`, `defineTool`, and `registerProvider` so
  hosts can configure the agent without adding a direct `@flue/runtime`
  dependency.

## Usage

```ts
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import { FlueCodingAgent, defineTool } from "@catamorphic/flue";
import { createCatamorphic } from "@catamorphic/server-sdk";

const sandboxProvider = new CloudflareSandboxProvider({
  apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
  apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
});

const catamorphic = createCatamorphic({
  database: { connectionString: process.env.DATABASE_URL! },
  storage: { projectManager },
  sandboxProvider,
  codingAgent: new FlueCodingAgent({
    // provider-id/model-id; the key comes from the host env
    // (OPENAI_API_KEY, ANTHROPIC_API_KEY, …) or registerProvider().
    model: "openai/gpt-5.2-codex",
    sandboxProvider,
    instructions: "Optional host-level system prompt prefix.",
    tools: [
      /* defineTool(...) — custom model-callable actions */
    ],
    skills: [
      /* host-application skills; see below for per-project skills */
    ],
  }),
});
```

Configuring `codingAgent` (plus `sandboxProvider`) enables
`core.agentSessions` and the `/projects/:projectId/agent/sessions` HTTP
routes.

## Skills

Two layers, resolved automatically:

1. **Host skills** — passed via the `skills` option; bundled with your app.
2. **Per-project skills** — files in the project repo under
   `.agents/skills/<name>/SKILL.md` ([Agent Skills](https://agentskills.io)
   layout). The dev sandbox clones the project from its origin (e.g.
   Cloudflare Artifacts), so Flue discovers them on disk in its workspace.
   They are versioned, multi-tenant, and editable through the normal
   catamorphic file APIs. See `docs/decisions/0010`.

## Integration tests

Real-stack tests (Cloudflare sandbox bridge + a live model key) are opt-in:

```bash
CF_SANDBOX_INTEGRATION=1 bun run test
```

Requires `CLOUDFLARE_SANDBOX_API_URL` (bridge running), and `OPENAI_API_KEY`
or `ANTHROPIC_API_KEY` in the root `.env`.
