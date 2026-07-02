# 0009 — Coding agents are pluggable; Flue is the flagship server-side agent

- **Status**: accepted
- **Date**: 2026-07-02

## Context

The coding agent (the AI that edits workflow code on behalf of the user) was
hard-wired to the OpenAI Codex SDK inside `@catamorphic/sandbox`, so every
embedder pulled in `@openai/codex-sdk` and had no way to bring their own
agent. Hosts embedding catamorphic have very different agent needs (vendor,
model, custom tools, skills), which is the same situation ADR 0008 resolved
for sandbox and storage backends.

## Decision

The coding agent follows the vendor-plugin pattern (ADR 0008):

- `@catamorphic/sandbox` keeps only the vendor-neutral contract —
  `CodingAgentProvider` (start/resume/sendMessage/dispose over a
  `ProviderSession`), the `AgentEvent` stream shape, and the shared plugin-doc
  staging helpers (`stagedPluginFiles`, `buildPluginsPreamble`). The Codex
  implementation moved out (this amends the ADR 0008 package list).
- `@catamorphic/codex` — the previous `CodexAgent`, unchanged behavior.
- `@catamorphic/flue` — `FlueCodingAgent`, backed by the Flue agent framework
  (https://flueframework.com). **This is the flagship implementation** and
  what the playground uses.
- Hosts select the agent at boot: `createCatamorphic({ codingAgent })` /
  `CatamorphicCoreConfig.codingAgent`. Configuring it (plus a
  `sandboxProvider`) enables `core.agentSessions` and the
  `/projects/:id/agent/sessions` HTTP routes.

**Execution model.** The Flue harness runs **in the host server process**,
not inside the sandbox. All file edits and shell commands are executed
remotely in the per-(project, user) Cloudflare dev sandbox through a Flue
`SandboxFactory` adapter (`catamorphicSandbox`) that maps Flue's sandbox API
onto catamorphic's `SandboxProvider` contract. Consequences of this split:

- Model/API keys stay on the server and never enter the sandbox.
- Any `SandboxProvider` works (Cloudflare, Daytona, host-supplied) without
  the agent knowing which.
- Session orchestration (dev sandbox lifecycle, message persistence in
  `agent_sessions` / `agent_messages`, post-turn sync-back of sandbox changes
  into the user's dev working copy as an uncommitted draft) lives in
  vendor-neutral `AgentSessionsService` in core, not in agent packages.

## Consequences

- Embedders install exactly the agent vendor SDK they use; a host can
  implement `CodingAgentProvider` themselves in a few dozen lines.
- Custom tools and host-level skills are configured on the Flue agent
  directly (`tools`, `skills`, `instructions` options) — catamorphic does not
  wrap or re-abstract Flue's tool/skill APIs.
- Agent changes reach the user's working copy through the normal git draft →
  deploy flow, so agent edits are reviewable and never silently committed.
- Flue harness state is in-process; after a host restart, sessions resume
  from persisted history with a fresh harness rather than replaying Flue
  internals.
