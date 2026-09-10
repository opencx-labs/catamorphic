import {
  type Context,
  type SpanOptions,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { OTLPLogExporter as GrpcLogs } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as JsonLogs } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as ProtoLogs } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter as GrpcMetrics } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as JsonMetrics } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as ProtoMetrics } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as GrpcTraces } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as JsonTraces } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoTraces } from "@opentelemetry/exporter-trace-otlp-proto";
import { envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LoggerProvider,
  type LogRecordProcessor,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOffSampler,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import {
  activeTelemetry,
  bindSpanTelemetry,
  ContextTracer,
  type TelemetryProviders,
} from "./scoped-telemetry.js";

export type TelemetryEnvironment = Record<string, string>;
export interface ProjectTelemetryConfiguration {
  local?: TelemetryEnvironment | false;
  remote?: TelemetryEnvironment | false;
}

/**
 * Exporter constructors synchronously snapshot standard OTEL environment config.
 * No async work or global provider registration is allowed inside this scope.
 * Restore every key before JavaScript can run another task.
 */
function withEnvironment<T>(env: TelemetryEnvironment, create: () => T): T {
  const saved = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("OTEL_")),
  );
  for (const key of Object.keys(saved)) delete process.env[key];
  for (const [key, value] of Object.entries(env))
    if (key.startsWith("OTEL_")) process.env[key] = value;
  try {
    return create();
  } finally {
    for (const key of Object.keys(process.env))
      if (key.startsWith("OTEL_")) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function signalExporters(signal: string): string[] {
  const configured =
    process.env[`OTEL_${signal}_EXPORTER`]?.trim() || undefined;
  const values =
    configured
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ??
    (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    process.env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]
      ? ["otlp"]
      : []);
  if (
    process.env.OTEL_SDK_DISABLED?.toLowerCase() === "true" ||
    values.includes("none")
  )
    return [];
  if (values.some((value) => value !== "otlp" && value !== "console"))
    throw new Error(`Unsupported project OTEL_${signal}_EXPORTER`);
  return [...new Set(values)];
}
function protocol(signal: string): string {
  const value =
    process.env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`]?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim() ||
    "http/protobuf";
  if (!["grpc", "http/json", "http/protobuf"].includes(value))
    throw new Error(`Unsupported project OTLP ${signal} protocol`);
  const endpoint =
    process.env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (endpoint && value !== "grpc") {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
      throw new Error("Invalid project OTLP HTTP endpoint");
  }
  return value;
}
function numberSetting(key: string): number | undefined {
  const raw = process.env[key];
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Separate providers let projects export metrics without project IDs as labels. */
export function createProjectTelemetry(args: {
  projectId: string;
  serviceName: string;
  configuration: ProjectTelemetryConfiguration;
}) {
  const spanProcessors: SpanProcessor[] = [];
  const processors: LogRecordProcessor[] = [];
  const readers: PeriodicExportingMetricReader[] = [];
  const destinations = [
    args.configuration.local,
    args.configuration.remote,
  ].filter((value): value is TelemetryEnvironment => !!value);
  try {
    for (const env of destinations)
      withEnvironment(env, () => {
        for (const exporter of signalExporters("TRACES")) {
          if (exporter === "console")
            spanProcessors.push(
              new SimpleSpanProcessor(new ConsoleSpanExporter()),
            );
          else {
            const kind = protocol("TRACES");
            const traceExporter =
              kind === "grpc"
                ? new GrpcTraces()
                : kind === "http/json"
                  ? new JsonTraces()
                  : new ProtoTraces();
            spanProcessors.push(new BatchSpanProcessor(traceExporter));
          }
        }
        for (const exporter of signalExporters("LOGS")) {
          if (exporter === "console")
            processors.push(
              new SimpleLogRecordProcessor({
                exporter: new ConsoleLogRecordExporter(),
              }),
            );
          else {
            const kind = protocol("LOGS");
            processors.push(
              new BatchLogRecordProcessor({
                exporter:
                  kind === "grpc"
                    ? new GrpcLogs()
                    : kind === "http/json"
                      ? new JsonLogs()
                      : new ProtoLogs(),
                maxQueueSize: numberSetting("OTEL_BLRP_MAX_QUEUE_SIZE"),
                maxExportBatchSize: numberSetting(
                  "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE",
                ),
                scheduledDelayMillis: numberSetting("OTEL_BLRP_SCHEDULE_DELAY"),
                exportTimeoutMillis: numberSetting("OTEL_BLRP_EXPORT_TIMEOUT"),
              }),
            );
          }
        }
        for (const exporter of signalExporters("METRICS")) {
          const kind = protocol("METRICS");
          readers.push(
            new PeriodicExportingMetricReader({
              exporter:
                exporter === "console"
                  ? new ConsoleMetricExporter()
                  : kind === "grpc"
                    ? new GrpcMetrics()
                    : kind === "http/json"
                      ? new JsonMetrics()
                      : new ProtoMetrics(),
              exportIntervalMillis: numberSetting(
                "OTEL_METRIC_EXPORT_INTERVAL",
              ),
              exportTimeoutMillis: numberSetting("OTEL_METRIC_EXPORT_TIMEOUT"),
            }),
          );
        }
      });
  } catch (error) {
    void Promise.allSettled(
      [...spanProcessors, ...processors, ...readers].map((component) =>
        component.shutdown(),
      ),
    );
    throw error;
  }
  const resource = withEnvironment(destinations[0] ?? {}, () =>
    resourceFromAttributes({ "service.name": args.serviceName })
      .merge(resourceFromAttributes(envDetector.detect().attributes ?? {}))
      .merge(
        resourceFromAttributes({ "catamorphic.project.id": args.projectId }),
      ),
  );
  const tracerProvider = withEnvironment(
    destinations[0] ?? {},
    () =>
      new NodeTracerProvider({
        resource,
        spanProcessors,
        ...(spanProcessors.length === 0
          ? { sampler: new AlwaysOffSampler() }
          : {}),
      }),
  );
  const meterProvider = new MeterProvider({ resource, readers });
  const loggerProvider = new LoggerProvider({ resource, processors });
  return {
    tracerProvider,
    meterProvider,
    loggerProvider,
    async shutdown() {
      await Promise.allSettled([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
    },
    async forceFlush() {
      await Promise.all([
        tracerProvider.forceFlush(),
        meterProvider.forceFlush(),
        loggerProvider.forceFlush(),
      ]);
    },
  };
}

export function installProjectTelemetry(args: {
  serviceName: string;
  resolve: (projectId: string) => ProjectTelemetryConfiguration | undefined;
  onError?: (projectId: string) => void;
}) {
  const fallback = trace.getTracerProvider();
  const projects = new Map<
    string,
    ReturnType<typeof createProjectTelemetry> | undefined
  >();
  const select = (
    options: SpanOptions,
    parent: Context,
  ): TelemetryProviders | undefined => {
    const id = options.attributes?.["catamorphic.project.id"];
    if (typeof id !== "string") return activeTelemetry(parent);
    if (!projects.has(id)) {
      try {
        const configuration = args.resolve(id);
        // A newly admitted project's folder may not be mapped yet. Absence
        // must remain resolvable on the next operation, not become permanent.
        if (configuration)
          projects.set(
            id,
            createProjectTelemetry({
              projectId: id,
              serviceName: args.serviceName,
              configuration,
            }),
          );
      } catch {
        // Invalid project config fails closed and never redirects to a host backend.
        try {
          args.onError?.(id);
        } catch {
          // Diagnostics must not turn an export failure into an app failure.
        }
        projects.set(
          id,
          createProjectTelemetry({
            projectId: id,
            serviceName: args.serviceName,
            configuration: {},
          }),
        );
      }
    }
    return projects.get(id);
  };
  const router: TracerProvider = {
    getTracer(name, version, options) {
      return new ContextTracer((spanOptions, parent) => {
        const providers = select(spanOptions, parent);
        const tracer = (providers?.tracerProvider ?? fallback).getTracer(
          name,
          version,
          options,
        );
        if (!providers) return tracer;
        return {
          startSpan(spanName, spanOptions, parent) {
            const span = tracer.startSpan(spanName, spanOptions, parent);
            bindSpanTelemetry({
              span,
              providers,
              projectId: spanOptions?.attributes?.["catamorphic.project.id"],
            });
            return span;
          },
          startActiveSpan: tracer.startActiveSpan.bind(tracer),
        };
      });
    },
  };
  trace.disable();
  trace.setGlobalTracerProvider(router);
  return {
    async shutdown() {
      await Promise.allSettled(
        [...projects.values()].map((project) => project?.shutdown()),
      );
      if (trace.getTracerProvider() === router) {
        trace.disable();
        trace.setGlobalTracerProvider(fallback);
      }
    },
  };
}
