import { type Attributes, context } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  CORRELATION_KEYS,
  correlationAttributes,
  telemetryContext,
} from "./correlation.js";
import { activeTelemetry } from "./scoped-telemetry.js";

export { SeverityNumber };

/** Official logs bridge only. The host owns the LoggerProvider and exporters. */
export function emitLog(args: {
  scope: string;
  body: string;
  severity?: SeverityNumber;
  attributes?: Attributes;
}): void {
  const severity = args.severity ?? SeverityNumber.INFO;
  const attributes = { ...args.attributes };
  for (const key of CORRELATION_KEYS) delete attributes[key];
  Object.assign(
    attributes,
    correlationAttributes(
      telemetryContext({ attributes: args.attributes ?? {} }),
    ),
  );
  (activeTelemetry()?.loggerProvider ?? logs.getLoggerProvider())
    .getLogger(args.scope)
    .emit({
      context: context.active(),
      body: args.body,
      severityNumber: severity,
      severityText:
        severity >= SeverityNumber.FATAL
          ? "FATAL"
          : severity >= SeverityNumber.ERROR
            ? "ERROR"
            : severity >= SeverityNumber.WARN
              ? "WARN"
              : severity >= SeverityNumber.INFO
                ? "INFO"
                : severity >= SeverityNumber.DEBUG
                  ? "DEBUG"
                  : "TRACE",
      attributes,
    });
}
