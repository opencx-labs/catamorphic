# Observability

Catamorphic emits traces, metrics, and structured diagnostic logs through the
OpenTelemetry APIs. The desktop and stock server include an optional Node SDK
bootstrap. Nothing is exported until an endpoint or exporter is configured.

## Stock server and desktop environment

Set standard OpenTelemetry variables before starting the host:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20YOUR_TOKEN
OTEL_SERVICE_NAME=catamorphic-server
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.namespace=my-team
```

An endpoint enables traces, logs, and metrics. Use `OTEL_TRACES_EXPORTER`,
`OTEL_LOGS_EXPORTER`, and `OTEL_METRICS_EXPORTER` to choose `otlp`, `console`,
or `none` independently. `OTEL_SDK_DISABLED=true` disables all export, including
desktop project destinations. The SDK additionally supports its standard
signal-specific exporters, such as Prometheus for host metrics.

The official exporters handle these standard settings:

| Configuration | Environment variables |
| --- | --- |
| Protocol | `OTEL_EXPORTER_OTLP_PROTOCOL`; `grpc`, `http/protobuf`, or `http/json` |
| Per-signal protocol | `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_PROTOCOL` |
| Endpoint | `OTEL_EXPORTER_OTLP_ENDPOINT` appends `/v1/traces`, `/v1/metrics`, `/v1/logs` for HTTP |
| Per-signal endpoint | `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` is used verbatim |
| Authentication | `OTEL_EXPORTER_OTLP_HEADERS` and per-signal `*_HEADERS`; percent-encode header values |
| Transport | `OTEL_EXPORTER_OTLP_TIMEOUT`, `*_COMPRESSION`, `*_CERTIFICATE`, `*_CLIENT_CERTIFICATE`, `*_CLIENT_KEY`, and their supported per-signal variants |
| Sampling | `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` |
| Trace batching | `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_EXPORT_TIMEOUT` |
| Log batching | Corresponding `OTEL_BLRP_*` settings |
| Metric collection | `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_METRIC_EXPORT_TIMEOUT` |
| Metric temporality | `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` |
| Resources | `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_NODE_RESOURCE_DETECTORS` |
| Propagation | `OTEL_PROPAGATORS` (W3C tracecontext and baggage by default) |
| SDK diagnostics | `OTEL_LOG_LEVEL` |

Signal-specific configuration overrides generic configuration according to the
SDK. Standard resource environment settings override the default service names
`catamorphic-desktop` and `catamorphic-server`. Exporters batch and retry using
the official SDK behavior. Shutdown drains all providers with a five-second
host budget; an unavailable collector cannot hold the app open indefinitely.

For desktop applications launched from Finder, put the same `OTEL_` assignments
in `<userData>/otel.env`. On a regular macOS install this is
`~/Library/Application Support/Catamorphic/otel.env`; development and E2E use
their isolated userData paths. The process environment takes precedence. Only
`OTEL_` keys are loaded. Restart after changing telemetry settings.

## Desktop project defaults and local overrides

A project can commit a `telemetry` section in `.catamorphic/project.json`:

```json
{
  "telemetry": {
    "local": {
      "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318"
    },
    "remote": {
      "OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.example.com:4318",
      "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf"
    }
  }
}
```

Either destination may be `false`. Set `"telemetry": false` to disable both
project destinations. Local endpoints must use loopback addresses. These
settings describe telemetry export, independently of whether the project has a
Git remote or is linked to another Catamorphic server.

Machine settings live in `<userData>/otel-projects.json`:

```json
{
  "defaults": { "local": false },
  "projects": {
    "YOUR_PROJECT_ID": {
      "remote": {
        "OTEL_EXPORTER_OTLP_HEADERS": "authorization=Bearer%20YOUR_TOKEN"
      }
    },
    "PRIVATE_PROJECT_ID": false
  }
}
```

Precedence is committed defaults, machine defaults, then machine project
overrides. Destination objects merge their OTEL keys; `false` disables that
destination. Keep authentication headers and private certificate paths in the
machine file. Project destinations do not inherit host exporter credentials.
If no project configuration exists, the host's ordinary configuration applies.
An explicit project configuration replaces host export for project work; it
never silently falls back to the host backend when disabled or invalid.

Explicit settings are resolved on first configured project use and cached until restart. Each
project has its own providers and metric resource, identified by
`catamorphic.project.id`. Descendant spans, metrics, and logs follow that scope,
including concurrent agent work. Local and remote receive the same project
signals, with independently configurable protocols and signal enablement.
Trace sampling and resource overrides are taken from the first destination
object (local before remote); configure them consistently if using both.
Project destinations support `otlp`, `console`, and `none`.

Unscoped host telemetry, such as startup and CPU/memory usage, uses `otel.env`
and the process environment. It is not copied into every project backend.

## Embedding

The libraries never register providers or exporters. Your existing OTel setup
remains authoritative. For the optional shared host bootstrap, install the
optional peers declared by `@catamorphic/otel` and import its Node entry point:

```ts
import { startTelemetry } from "@catamorphic/otel/node";

const telemetry = startTelemetry({
  serviceName: "my-host",
  configuration: {
    // Standard NodeSDKConfiguration: supply any exporters or processors,
    // metricReaders, logRecordProcessors, sampler, resource, or views.
  },
});
// Mount Catamorphic, start your workers, and serve requests.
// Stop workers and close requests before draining telemetry.
await telemetry.shutdown();
```

For Fastify, explicitly call `instrumentHttpServer(app)` from
`@catamorphic/fastify-plugin` before starting the host, or use your own HTTP
instrumentation. The shipped hosts use explicit lifecycle hooks, which also
work under Bun and Electron bundling. Do not add both on the same server.

## Coverage

| Surface | Signals |
| --- | --- |
| HTTP | Server span, W3C parent extraction, route-template duration histogram, response status, structured completion/error/disconnect log |
| Projects and git | Create, update, delete, file reads/writes, checkpoints, branches, draft discard, conflict resolution, deployment, remote sync, PR operations |
| Documents and apps | Document writes, reads, binary reads, deletion, search; app build, publish, bundles, local storage |
| Workflows | Triggering, execution jobs, worker dispatch, runtime deployment/invocation, boundary/batch dispatch, runtime events, pause/resume/cancel |
| Agent orchestration | Session create, send/enqueue, run, fork, retry, interrupt, close, handoff, checkpoints, runtime events/requests |
| Built-in AI SDK harnesses | Agent invocation, each model call, each executed tool including MCP and host tools, nested tool work, usage and latency metrics, settlement logs |
| Sandbox providers | Create/start/stop/destroy/status, exec and exit status, upload/download, git clone/checkout, runtime ensure/invoke/cancel/health, workspace hydration |
| Background services | Existing watcher, schedule, retention, connection, session-sync, event and mailbox spans |
| Host process | Resident memory and cumulative user/system CPU time |

Every `withSpan` operation records `catamorphic.operation.duration` and
`catamorphic.operation.active`. Metric dimensions contain fixed operation names
and outcomes, not project/session IDs, file paths, commands, or user content.
Handled failures use `markSpanError`; rejected operations emit a correlated
error log and exception type. Sandbox nonzero exit codes are errors even when
the provider returns normally. Successful callbacks never overwrite an error
status set by the operation.

Both `AiSdkCodingAgent` and `AiSdkAgentRuntime` use the OpenTelemetry GenAI
Development conventions: `invoke_agent`, `chat`, and `execute_tool`, with
`gen_ai.*` attributes. Metrics cover model duration, input/output tokens,
time to first output, agent duration, model/tool call counts, and tool duration.
Usage comes from provider reports; missing counts are omitted. User cancellation
is a separate outcome. Failed or abandoned streams close outstanding spans.
Prompts, messages, reasoning, tool inputs/results, and provider error bodies are
not captured. Error types remain available without potentially sensitive text.

External harnesses (Claude Code/Codex) expose the lifecycle Catamorphic owns.
We do not infer their internal model or tool spans. Project exporter
credentials are not added to harness subprocesses. External harness telemetry
uses the harness's own configuration and inherited process environment. Workflow sandbox subprocesses likewise do not receive
host exporter credentials; the host-side runtime and dispatch spans cover that
boundary. Durable jobs correlate through run/session/attempt IDs; there is no
claim that a single trace survives every process restart. Arbitrary SQL queries,
renderer interactions, guest-app code, and arbitrary console output are not
automatically instrumented. Hosts can add those instrumentations themselves.

## Local collector

`bun run dev:infra` starts the repository collector. Point the host's endpoint
at `http://127.0.0.1:4318` to export logs, metrics, and traces to its ClickHouse
pipelines. Starting the development host does not opt into export implicitly.

## Standards

- [OTLP exporter configuration](https://opentelemetry.io/docs/specs/otel/protocol/exporter/)
- [JavaScript Node SDK](https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-node.html)
- [GenAI span and metric conventions](https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai), reviewed September 10, 2026. These conventions are still Development; the mapping is isolated in `packages/ai-sdk/src/telemetry.ts`.

## Correlation for analytics

Catamorphic spans and `emitLog` records inherit an allowlisted set of correlation
attributes from local OTel Context (ADR 0120). Parent attributes such as HTTP
status, operation names, tool names, error types, or arbitrary content do not
inherit. These IDs are span/log attributes, never metric labels:

| Field | Meaning |
| --- | --- |
| `catamorphic.tenant.id`, `user.id` | Host tenant and opaque execution actor |
| `catamorphic.project.id` | Project containing the work |
| `catamorphic.agent.session.id` | Canonical Catamorphic agent session |
| `gen_ai.conversation.id` | Built-in harness conversation, equal to its session ID |
| `catamorphic.agent.turn.id` | Durable inbox or runtime turn ID, including model/tool descendants |
| `catamorphic.run.id`, `catamorphic.workflow.name` | Workflow execution |
| `catamorphic.commit.sha`, `catamorphic.deployment_artifact.id` | Deployed source and artifact |
| `catamorphic.queue.job.id`, `.kind`, `.attempt` | Execution job and claim attempt |
| `catamorphic.workflow.step.attempt.id` | Persisted workflow step attempt |

Authenticated HTTP requests and scoped SDK calls supply tenant/user attribution.
The actor is the identity executing the operation; for workflow jobs it is the
run's persisted user. It is not necessarily the author of a message that triggered
an agent. Jobs reload run attribution from Postgres, including inline execution
and retries. Agent inbox execution uses the claimed turn ID; legacy sessions
without a corresponding durable turn record may omit it. Correlation can survive
restarts even when execution starts a new trace.

Changing tenant/project/session/run clears incompatible inherited identifiers.
A fresh SDK actor, each claimed workflow job, and each claimed agent turn start a fresh correlation scope; nested SDK
calls by the same actor preserve their calling context. Concurrent operations use
isolated snapshots. Fields discovered later enrich subsequent children; spans
already ended cannot be changed retroactively. Exporter choice is made when a
span starts, so bind the project before starting a span whenever it is known.

Libraries continue to use only OTel APIs. Embedders can scope their own work:

```ts
import { withTelemetryContext, getTracer, withSpan } from "@catamorphic/otel";

await withTelemetryContext({
  attributes: {
    "catamorphic.tenant.id": identity.tenantId,
    "user.id": identity.externalUserId,
    "catamorphic.project.id": projectId,
  },
}, () => withSpan({ tracer: getTracer("my-host"), name: "host.operation" }, work));
```

Catamorphic's tracer enriches spans before sampling. Other instrumentations that
use the raw OTel tracer can opt into the exported `CorrelationSpanProcessor` from
`@catamorphic/otel/node`, placed before exporting processors in the host's SDK
configuration. It enriches spans on start, after sampling. Preserve the host's
exporting processors when adding it. Third-party log bridges need their own
attribute enrichment; `emitLog` is enriched automatically. No SDK globals are
installed by importing a library.

Correlation stays local by default. `currentTraceContext()` and
`injectTelemetryContext()` omit baggage unless the latter receives an explicit
`baggageKeys` allowlist. `extractTelemetryContext({ carrier, baggageKeys })`
accepts only those keys and removes baggage afterward. These helpers honor the
host's configured propagators; W3C baggage must be enabled for baggage transport.
Authenticate the remote peer before opting into extraction. Ordinary HTTP ingress
accepts trace context but discards baggage. Public HTTP ingress never derives identity, authorization, or
project exporter selection from baggage. A trusted peer allowlisted for project
correlation can influence telemetry routing; only allow that key when the host
authorizes the peer for that project. Correlation never grants application access. Model providers and
arbitrary MCP servers do not receive Catamorphic correlation baggage.

For analytics, count `agent.turn` spans for core turn executions, or
`invoke_agent` operations for standalone harness invocations; do not add both.
Count distinct turn IDs for logical turns and model `chat` spans for model attempts.
Sum token usage on model spans only. Retry attempts are separate spans. Sampling
and export loss affect trace-derived totals; use metrics for aggregate monitoring and persisted
application records when exact accounting is required.
