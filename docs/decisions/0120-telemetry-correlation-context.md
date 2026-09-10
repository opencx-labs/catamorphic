# 0120 — Telemetry correlation context

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

Trace parentage alone requires backend joins to associate model, tool, sandbox,
and workflow operations with their project, user, session, turn, or run. Queued
work also needs correlation after the originating request or process ends.

## Decision

Use the existing OTel Context and tracer helpers to carry an allowlisted set of
correlation attributes and enrich Catamorphic spans and logs automatically.
Hosts retain ownership of providers and can install the exported correlation
span processor for other instrumentations. IDs never become metric labels.

Bind tenant and opaque `user.id` from host-authenticated identity; bind project,
agent session/turn and workflow run/attempt from application records. Reconstruct
queued correlation from persisted records. Changing tenant, project, session,
or run clears incompatible inherited identifiers. Concurrent operations use
immutable context snapshots, never process-global identity.

Correlation stays local by default. Explicit trusted-boundary helpers transport
only caller-allowlisted keys using W3C baggage; ordinary HTTP ingress drops baggage
and never derives identity or exporter routing from it. Hosts opt in only after
validating the remote peer. Trace context may continue independently of baggage.
Do not forward correlation to model providers or arbitrary MCP endpoints.

## Consequences

Individual span and log rows support analytics without parent traversal. Export
sampling still applies; count canonical turn spans for turns and model spans for
model attempts. Correlation across queued work does not imply a continuous trace
across process restarts. No workflow protocol or database migration is needed.
