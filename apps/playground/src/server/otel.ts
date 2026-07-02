/**
 * OpenTelemetry SDK wiring for the playground server.
 *
 * Catamorphic libraries instrument exclusively against `@opentelemetry/api`;
 * the *host* owns the SDK. The playground plays that host role: it exports
 * traces over OTLP/HTTP to the dev collector from docker-compose.yml, which
 * writes them to ClickHouse (database `otel`, HTTP UI on localhost:8124).
 *
 * Export failures are invisible by default (the OTel diag logger is a no-op),
 * so running the playground without the collector is harmless.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";

export function initTelemetry(): (() => Promise<void>) | undefined {
  if (process.env.OTEL_SDK_DISABLED === "true") return undefined;

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT;

  const provider = new NodeTracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: "catamorphic-playground",
      }),
    ),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      ),
    ],
  });
  provider.register();

  console.log(`[playground] OTel traces → ${endpoint} (OTLP/HTTP)`);
  return () => provider.shutdown();
}
