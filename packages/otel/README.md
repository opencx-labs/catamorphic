# @catamorphic/otel

Tiny OpenTelemetry helpers shared by catamorphic packages.

Library instrumentation uses `@opentelemetry/api` and `@opentelemetry/api-logs`. The host owns tracer, meter, and logger providers, exporters, and sampling. Without providers, instrumentation is a no-op. The optional `@catamorphic/otel/node` entry point initializes the shipped hosts and supports standard OTEL environment configuration and custom NodeSDK options. See [OBSERVABILITY.md](../../OBSERVABILITY.md) and ADR 0119.

```ts
import { getTracer, withSpan } from "@catamorphic/otel";

const tracer = getTracer("@catamorphic/core");

await withSpan(
  {
    tracer,
    name: "project.deploy",
    attributes: { "catamorphic.project.id": projectId },
  },
  async (span) => {
    // work; rejected operations record error type, status, and a log
  },
);
```

Conventions:

- Tracer scope = package name (`@catamorphic/core`, `@catamorphic/sandbox`, …).
- Standard HTTP and GenAI attributes follow OTel conventions. Framework attribute names use the `catamorphic.` prefix (`catamorphic.tenant.id`, `catamorphic.run.id`, `catamorphic.workflow.name`, `catamorphic.sandbox.*`).
- Sandbox providers are wrapped automatically via `instrumentSandboxProvider` (in `@catamorphic/sandbox`) when handed to `CatamorphicCore`.

`withSpan` also records duration and active-operation metrics with bounded
attributes. Use `markSpanError({ span, errorType })` for handled failures.
Use `getMeter(scope)` for domain metrics and `emitLog({ scope, body, severity,
attributes })` for structured logs. Do not record prompts, commands, file
contents, tool inputs/results, credentials, or IDs as metric labels.

Correlation IDs inherit automatically on Catamorphic spans and `emitLog` records.
Use `withTelemetryContext({ attributes }, callback)` for host scopes and
`setSpanCorrelation({ span, attributes })` for IDs discovered during an operation.
Use a fresh scope/span when changing identity. The `/node` entry exports
`CorrelationSpanProcessor` for host-owned third-party instrumentation. Trusted
service boundaries may explicitly opt into `injectTelemetryContext` and
`extractTelemetryContext` with a `baggageKeys` allowlist; no baggage is forwarded by
default. See the correlation section in [OBSERVABILITY.md](../../OBSERVABILITY.md)
for field definitions, scope resets, and analytics counting semantics.
