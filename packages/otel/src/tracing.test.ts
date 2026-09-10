import { context, metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTracer, markSpanError, withSpan } from "./tracing.js";

// Import and resolve tracers before registration, as consumers commonly do.
const tracer = getTracer("@catamorphic/test");
const spans = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spans)],
});
const exportedLogs = new InMemoryLogRecordExporter();
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({ exporter: exportedLogs })],
});
const exportedMetrics = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
);
const meterProvider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({
      exporter: exportedMetrics,
      exportIntervalMillis: 3_600_000,
    }),
  ],
});

beforeAll(() => {
  provider.register();
  metrics.setGlobalMeterProvider(meterProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
});
afterAll(async () => {
  await Promise.all([
    provider.shutdown(),
    meterProvider.shutdown(),
    loggerProvider.shutdown(),
  ]);
  trace.disable();
  metrics.disable();
  logs.disable();
  context.disable();
});

describe("service instrumentation", () => {
  it("preserves async parents and isolates concurrent operations", async () => {
    await Promise.all(
      ["one", "two"].map((name) =>
        withSpan({ tracer, name }, async (parent) => {
          await Promise.resolve();
          await withSpan({ tracer, name: `${name}.child` }, async (child) => {
            expect(child.spanContext().traceId).toBe(
              parent.spanContext().traceId,
            );
          });
        }),
      ),
    );
    const all = spans.getFinishedSpans();
    for (const name of ["one", "two"]) {
      const parent = all.find((span) => span.name === name);
      const child = all.find((span) => span.name === `${name}.child`);
      expect(child?.parentSpanContext?.spanId).toBe(
        parent?.spanContext().spanId,
      );
    }
    expect(
      all.find((span) => span.name === "one")?.spanContext().traceId,
    ).not.toBe(all.find((span) => span.name === "two")?.spanContext().traceId);
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it("ends failed spans and rethrows the original error", async () => {
    const error = new TypeError("test failure");
    await expect(
      withSpan({ tracer, name: "failed" }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const span = spans
      .getFinishedSpans()
      .find((span) => span.name === "failed");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("TypeError");
    expect(span?.events[0]?.name).toBe("exception");
  });

  it("does not overwrite an error recorded by a successful callback", async () => {
    expect(
      await withSpan({ tracer, name: "domain_failure" }, async (span) => {
        span.setStatus({ code: SpanStatusCode.ERROR });
        return { success: false };
      }),
    ).toEqual({ success: false });
    expect(
      spans.getFinishedSpans().find((span) => span.name === "domain_failure")
        ?.status.code,
    ).toBe(SpanStatusCode.ERROR);
  });

  it("records bounded duration dimensions independently of IDs and content", async () => {
    await withSpan(
      {
        tracer,
        name: "metric_test",
        attributes: {
          "catamorphic.project.id": "private-project",
          untrusted: "private-content",
        },
      },
      async () => {},
    );
    await meterProvider.forceFlush();
    const all = exportedMetrics
      .getMetrics()
      .flatMap((m) => m.scopeMetrics)
      .flatMap((m) => m.metrics);
    const duration = all.find(
      (m) => m.descriptor.name === "catamorphic.operation.duration",
    );
    expect(
      duration?.dataPoints.some(
        (point) =>
          point.attributes["catamorphic.operation.name"] === "metric_test",
      ),
    ).toBe(true);
    expect(JSON.stringify(all)).not.toContain("private-project");
    expect(JSON.stringify(all)).not.toContain("private-content");
    const active = all.find(
      (m) => m.descriptor.name === "catamorphic.operation.active",
    );
    expect(active?.dataPoints.every((point) => point.value === 0)).toBe(true);
  });

  it("reports handled failures in all three signals without changing the returned result", async () => {
    const result = await withSpan(
      { tracer, name: "handled_failure" },
      async (span) => {
        markSpanError({ span, errorType: "BuildFailed" });
        return { success: false };
      },
    );
    expect(result).toEqual({ success: false });
    await Promise.all([
      meterProvider.forceFlush(),
      loggerProvider.forceFlush(),
    ]);
    const span = spans
      .getFinishedSpans()
      .find((span) => span.name === "handled_failure");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    const log = exportedLogs
      .getFinishedLogRecords()
      .find(
        (log) =>
          log.attributes["catamorphic.operation.name"] === "handled_failure",
      );
    expect(log?.attributes["error.type"]).toBe("BuildFailed");
    expect(log?.spanContext?.spanId).toBe(span?.spanContext().spanId);
    const measurements = exportedMetrics
      .getMetrics()
      .flatMap((metric) => metric.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    expect(
      measurements.some((metric) =>
        metric.dataPoints.some(
          (point) =>
            point.attributes["catamorphic.operation.name"] ===
              "handled_failure" &&
            point.attributes["error.type"] === "BuildFailed",
        ),
      ),
    ).toBe(true);
  });
});
