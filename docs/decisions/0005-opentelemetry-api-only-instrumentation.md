# 0005 — OpenTelemetry instrumentation via `@opentelemetry/api` only

- **Status:** Accepted
- **Date:** 2026-07-02

## Context

Hosts need visibility into workflow runs, deploys, and sandbox operations, correlated with their own request traces. As an embedded library, catamorphic must not own exporters, sampling, or a tracer provider — that's host policy.

## Decision

Catamorphic libraries instrument **exclusively against `@opentelemetry/api`** through the tiny `@catamorphic/otel` package (`getTracer`, `withSpan`). The host registers the OpenTelemetry SDK (provider, exporters, sampling); until it does, all spans are no-ops with negligible overhead.

Conventions:

- Tracer scope = package name (`@catamorphic/core`, `@catamorphic/sandbox`, …).
- Attributes use the `catamorphic.` prefix: `catamorphic.tenant.id`, `catamorphic.project.id`, `catamorphic.run.id`, `catamorphic.workflow.name`, `catamorphic.sandbox.*`.
- Hot paths get spans: `workflow.run` (trigger), `workflow.execute` (sandbox execution), `project.create`, `project.deploy`, and every `SandboxProvider` operation (`sandbox.create`, `sandbox.exec`, `sandbox.upload_files`, …).
- Sandbox providers — including host-supplied ones — are wrapped automatically by `instrumentSandboxProvider` inside `CatamorphicCore`; never double-wrap.
- New service methods on hot paths should be instrumented as part of the change that adds them.

## Consequences

- Hosts get catamorphic spans in their existing traces for free; no config surface to maintain.
- Because spans nest via active context, sandbox operations appear as children of `workflow.execute` automatically.
- HTTP-layer tracing is deliberately left to the host's Fastify instrumentation.
