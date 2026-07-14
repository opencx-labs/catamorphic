import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

export type SpanAttributes = Attributes;

/**
 * Catamorphic instruments exclusively against `@opentelemetry/api`. The host
 * application owns the OpenTelemetry SDK: it registers the global tracer
 * provider, exporters, and sampling. When the host registers nothing, every
 * span produced here is a no-op with negligible overhead.
 */
export function getTracer(instrumentationScope: string): Tracer {
  return trace.getTracer(instrumentationScope);
}

export function currentTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export interface WithSpanOptions {
  tracer: Tracer;
  name: string;
  attributes?: SpanAttributes;
}

/**
 * Run `fn` inside an active span. The span is ended when the promise settles;
 * rejections record the exception and mark the span as errored before
 * rethrowing.
 */
export async function withSpan<T>(
  { tracer, name, attributes }: WithSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
