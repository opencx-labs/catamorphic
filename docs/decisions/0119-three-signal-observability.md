# 0119: Host-owned three-signal observability

- **Status:** Accepted
- **Date:** 2026-09-10
- **Refines:** 0005

## Context

The libraries emit selected spans but neither shipped host initializes an SDK.
There is no metric instrumentation, log bridge, or built-in agent telemetry.
The development collector accepts traces only.

## Decision

Keep library instrumentation API-only, extending the existing OTel API boundary
with the official `@opentelemetry/api-logs` bridge. Hosts retain full control of
providers, processors, exporters, sampling, resources, and views.

Add an explicit `@catamorphic/otel/node` host entry point backed by the official
NodeSDK. Only hosts import it. SDK dependencies are optional peers so library
consumers do not acquire a Node SDK. Desktop and stock-server entry points start
it before application work and drain it after application shutdown. Standard
OTEL environment variables configure signals, endpoints, protocols, headers,
resources, sampling, batching, and intervals. Export is opt-in: an explicit
exporter or OTLP endpoint enables it; unconfigured installs send nothing.
Desktop additionally accepts a machine-local OTEL environment file, with the
process environment taking precedence, for applications launched from Finder.

Use explicit HTTP hooks in the shipped hosts (no import-time monkey patching,
which is unreliable under Bun and Electron bundling). Library operations emit
bounded-cardinality duration/error metrics and correlated diagnostic logs.
Built-in AI SDK harnesses emit agent, inference, and tool spans and token/duration
metrics using the OTel GenAI development conventions. Keep the mapping isolated;
do not export prompts, messages, tool inputs/results, or reasoning. External
harness internals remain opaque; instrument only the lifecycle we actually own.

## Consequences

One optional host bootstrap serves both shipped products without taking control
from embedders. Exporter failure must not interrupt user work. Tests use in-memory
exporters and a local OTLP receiver, including configuration precedence, context,
shutdown, failures, and streaming agent/tool coverage. Desktop project manifests may preconfigure independent local and remote OTLP
destinations; machine-local overrides can replace or disable either. Project
spans select independent providers, inherited by descendants, logs, and metrics;
concurrent projects never switch a shared exporter. Project settings are resolved
on first use for the lifetime of the desktop process. The dev collector receives
all three signals. Document exact coverage and remaining boundaries.
