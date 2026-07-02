# @catamorphic/otel

Tiny OpenTelemetry helpers shared by catamorphic packages.

Catamorphic instruments **exclusively against `@opentelemetry/api`** (see `docs/decisions/0005`): the host application owns the OpenTelemetry SDK — tracer provider, exporters, sampling. When the host registers nothing, every span is a no-op with negligible overhead.

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
    // work; span records exceptions + error status automatically
  },
);
```

Conventions:

- Tracer scope = package name (`@catamorphic/core`, `@catamorphic/sandbox`, …).
- Attribute names use the `catamorphic.` prefix (`catamorphic.tenant.id`, `catamorphic.run.id`, `catamorphic.workflow.name`, `catamorphic.sandbox.*`).
- Sandbox providers are wrapped automatically via `instrumentSandboxProvider` (in `@catamorphic/sandbox`) when handed to `CatamorphicCore`.
