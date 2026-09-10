export {
  CORRELATION_KEYS,
  type CorrelationKey,
  correlationAttributes,
  extractTelemetryContext,
  injectTelemetryContext,
  setSpanCorrelation,
  telemetryContext,
  withTelemetryContext,
} from "./correlation.js";
export { emitLog, SeverityNumber } from "./logging.js";
export { getMeter } from "./metrics.js";
export type { SpanAttributes, WithSpanOptions } from "./tracing.js";
export {
  currentTraceContext,
  getTracer,
  markSpanError,
  withSpan,
} from "./tracing.js";
