# 0018 - AI SDK ToolLoopAgent is the flagship coding agent

- **Status**: accepted
- **Date**: 2026-07-21
- **Supersedes**: 0009's choice of Flue as the flagship implementation

## Context

ADR 0009 made coding agents pluggable and selected Flue as the flagship
host-side harness. We want to remove that dependency, let hosts inject any
Vercel AI SDK model directly, and keep the agent runtime in the host process
without a CLI, daemon, bridge, or sidecar. The code workspace must remain in
the host-provided development sandbox.

## Decision

`@catamorphic/ai-sdk` is the flagship coding-agent plugin and the playground's
default implementation. `AiSdkCodingAgent` implements `CodingAgentProvider`
with Vercel AI SDK's in-process `ToolLoopAgent` and accepts a host-constructed
AI SDK `LanguageModel`.

The package stays deliberately small:

- `read`, `write`, `edit`, and `bash` tools call the configured
  `SandboxProvider` against the session's working directory;
- direct filesystem tool paths outside that working directory are rejected;
- AI SDK model messages provide in-memory multi-turn history;
- existing shared helpers stage attached plugin documentation;
- the agent reads project skills from `.agents/skills/` through its normal
  filesystem tools rather than adding a separate skill runtime;
- no custom compaction, subagent, permission, or durable harness layer is
  introduced.

Flue and `@catamorphic/flue` are removed. `@catamorphic/codex` remains an
optional alternate provider. The vendor-neutral contracts and session
orchestration established by ADR 0009 remain in force.

## Consequences

- Hosts choose model providers and credentials by injecting an AI SDK model;
  Catamorphic does not own provider configuration.
- Model calls stay in the host and project commands stay in the sandbox.
- Agent sessions remain in-process. A host restart requires a new session,
  matching the practical behavior of the previous implementation.
- Migration 018 closes active persisted Flue sessions because their provider
  state cannot be resumed by the new implementation.
- More advanced harness behavior can be added later only when concrete needs
  justify it; the initial integration relies on AI SDK primitives.
