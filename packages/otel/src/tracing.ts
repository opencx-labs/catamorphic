import type { Attributes, Span, SpanKind, Tracer } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";

import { injectTelemetryContext } from "./correlation.js";
import { emitLog, SeverityNumber } from "./logging.js";
import { measureOperation } from "./metrics.js";
import { contextualTracer } from "./scoped-telemetry.js";

export type SpanAttributes = Attributes;

/**
 * Catamorphic instruments exclusively against `@opentelemetry/api`. The host
 * application owns the OpenTelemetry SDK: it registers the global tracer
 * provider, exporters, and sampling. When the host registers nothing, every
 * span produced here is a no-op with negligible overhead.
 */
export function getTracer(instrumentationScope: string): Tracer {
  return contextualTracer(instrumentationScope);
}

export function currentTraceContext(): Record<string, string> {
  return injectTelemetryContext();
}

export interface WithSpanOptions {
  tracer: Tracer;
  name: string;
  attributes?: SpanAttributes;
  kind?: SpanKind;
}

const spanErrors = new WeakMap<Span, string>();

/** Mark a handled domain failure without throwing away the operation's result. */
export function markSpanError(args: { span: Span; errorType: string }): void {
  spanErrors.set(args.span, args.errorType);
  args.span.setAttribute("error.type", args.errorType);
  args.span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Run `fn` inside an active span. The span is ended when the promise settles;
 * rejections record the exception and mark the span as errored before
 * rethrowing.
 */
export async function withSpan<T>(
  { tracer, name, attributes, kind }: WithSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes, kind }, async (span) => {
    const finish = measureOperation(name);
    let errorType: string | undefined;
    try {
      const result = await fn(span);
      return result;
    } catch (err) {
      errorType = err instanceof Error ? err.name : "_OTHER";
      span.setAttribute("error.type", errorType);
      span.recordException({ name: errorType });
      span.setStatus({
        code: SpanStatusCode.ERROR,
      });
      throw err;
    } finally {
      const failure = errorType ?? spanErrors.get(span);
      if (failure)
        emitLog({
          scope: "@catamorphic/otel",
          body: "Operation failed",
          severity: SeverityNumber.ERROR,
          attributes: {
            "catamorphic.operation.name": name,
            "error.type": failure,
          },
        });
      finish(failure);
      span.end();
    }
  });
}
