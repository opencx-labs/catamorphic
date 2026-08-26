# ADR 0067: Long-lived agent runtimes and a unified capability gateway

- **Status:** Accepted
- **Date:** 2026-08-24
- **Supersedes in part:** 0038, 0054, 0064

## Context

The coding-agent contract is shaped around one `sendMessage()` iterator.
Claude Code and Codex expose richer session events, approvals, questions,
tasks, plans, and background activity that do not fit inside one turn. Host
tools are also wired differently for each harness, and four topology labels
mix agent-loop placement with isolation implementation.

## Decision

Replace `CodingAgentProvider` with a long-lived `AgentRuntimeProvider` that
separates session and turn commands from an independently resumable event
subscription. Normalize lifecycle, messages, tools, requests, plans, tasks,
processes, workspace changes, usage, and errors. Providers publish a capability
descriptor and pass one conformance suite.

Replace `ExtraTool` and harness-specific workspace bridges with one
host-injected capability registry and gateway. Every invocation uses the same
schema validation, identity and Allocation context, layered policy, approval,
progress, cancellation, structured result, audit, and telemetry pipeline.
In-process calls, MCP, and provider dynamic tools are transports over that
registry.

Replace `controller | contained | native | external` with agent-loop placement
`control_plane | environment`. Isolation, local subprocesses, sandboxes, VMs,
and provider-hosted runtimes are Environment-runner implementation details.
The Allocation owns workspace, process, and capability routing.

Claude Code consumes the full Agent SDK stream without a static tool allowlist.
Codex uses a long-lived app-server connection with approvals, input,
elicitation, dynamic tools, items, plans, subagents, and usage.

## Consequences

Hosts gain one interception seam and can build durable UI without
provider-name branches. Sessions and background activity may outlive turns and
resume by event cursor. Provider adapters become larger and must report
unsupported behavior honestly. This is a breaking greenfield cutover: old
contracts, topology aliases, and bespoke tool bridges are deleted.
