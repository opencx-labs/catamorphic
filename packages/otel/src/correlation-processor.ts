import type { Context } from "@opentelemetry/api";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { setSpanCorrelation, telemetryContext } from "./correlation.js";

/** Host opt-in enrichment for instrumentations that do not use Catamorphic's tracer. */
export class CorrelationSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    setSpanCorrelation({
      span,
      attributes: span.attributes,
      parent: telemetryContext({
        parent: parentContext,
        attributes: span.attributes,
      }),
    });
  }
  onEnd(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
