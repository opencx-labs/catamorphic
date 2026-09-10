import {
  type Context,
  context,
  type MeterProvider,
  ROOT_CONTEXT,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";

import {
  CORRELATION_KEYS,
  correlationAttributes,
  setSpanCorrelation,
  telemetryContext,
} from "./correlation.js";

/** Providers remain host-owned; scope follows the active span, never a global project. */
export interface TelemetryProviders {
  tracerProvider: TracerProvider;
  meterProvider: MeterProvider;
  loggerProvider: LoggerProvider;
}
const scopes = new WeakMap<
  Span,
  { providers: TelemetryProviders; projectId: unknown }
>();
export function bindSpanTelemetry(args: {
  span: Span;
  providers: TelemetryProviders;
  projectId?: unknown;
}): void {
  scopes.set(args.span, {
    providers: args.providers,
    projectId: args.projectId,
  });
}
export function activeTelemetry(
  parent = context.active(),
): TelemetryProviders | undefined {
  const span = trace.getSpan(parent);
  const bound = span ? scopes.get(span) : undefined;
  return bound?.projectId ===
    correlationAttributes(parent)["catamorphic.project.id"]
    ? bound?.providers
    : undefined;
}

/** Resolve at operation time, including for libraries imported before SDK boot. */
export class ContextTracer implements Tracer {
  constructor(
    private readonly resolve: (options: SpanOptions, parent: Context) => Tracer,
  ) {}
  startSpan(
    name: string,
    options: SpanOptions = {},
    parent = context.active(),
  ): Span {
    const scopedParent = telemetryContext({
      parent: options.root ? ROOT_CONTEXT : parent,
      attributes: options.attributes ?? {},
    });
    const attributes = { ...options.attributes };
    for (const key of CORRELATION_KEYS) delete attributes[key];
    Object.assign(attributes, correlationAttributes(scopedParent));
    const enriched = { ...options, attributes };
    const span = this.resolve(enriched, scopedParent).startSpan(
      name,
      enriched,
      scopedParent,
    );
    setSpanCorrelation({
      span,
      attributes: correlationAttributes(scopedParent),
      parent: scopedParent,
    });
    return span;
  }
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    parent: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan(
    name: string,
    optionsOrFn: SpanOptions | ((span: Span) => unknown),
    parentOrFn?: Context | ((span: Span) => unknown),
    callback?: (span: Span) => unknown,
  ): unknown {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const parent =
      parentOrFn && typeof parentOrFn !== "function"
        ? parentOrFn
        : context.active();
    const fn =
      typeof optionsOrFn === "function"
        ? optionsOrFn
        : typeof parentOrFn === "function"
          ? parentOrFn
          : callback;
    if (!fn) throw new TypeError("A span callback is required");
    const span = this.startSpan(name, options, parent);
    return context.with(trace.setSpan(parent, span), fn, undefined, span);
  }
}

export function contextualTracer(scope: string): Tracer {
  return new ContextTracer((options, parent) => {
    const providers =
      typeof options.attributes?.["catamorphic.project.id"] === "string"
        ? undefined
        : activeTelemetry(parent);
    const tracer = (
      providers?.tracerProvider ?? trace.getTracerProvider()
    ).getTracer(scope);
    if (!providers) return tracer;
    return new ContextTracer(() => ({
      ...tracer,
      startSpan(name, spanOptions = options, spanParent = parent) {
        const span = tracer.startSpan(name, spanOptions, spanParent);
        bindSpanTelemetry({
          span,
          providers,
          projectId: spanOptions.attributes?.["catamorphic.project.id"],
        });
        return span;
      },
      startActiveSpan: tracer.startActiveSpan.bind(tracer),
    }));
  });
}
