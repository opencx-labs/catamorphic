import { getTracer, withSpan, withTelemetryContext } from "@catamorphic/otel";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { context, metrics, SpanStatusCode, trace } from "@opentelemetry/api";
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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createAiSdkAdapter } from "../adapter.js";
import {
  hangingCall,
  replayModel,
  replyCall,
  streamErrorCall,
  toolCallsCall,
} from "../testing/index.js";
import { attemptStart, FakeHost } from "./fake-host.js";

const spans = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spans)],
});
const metricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
);
const meterProvider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 3_600_000,
    }),
  ],
});
beforeAll(() => {
  provider.register();
  metrics.setGlobalMeterProvider(meterProvider);
});
beforeEach(() => spans.reset());
afterAll(async () => {
  await Promise.all([provider.shutdown(), meterProvider.shutdown()]);
  trace.disable();
  context.disable();
  metrics.disable();
});
function sandbox(): SandboxProvider {
  return {
    workspaceRoot: "/workspace",
    createSandbox: vi.fn(),
    startSandbox: vi.fn(),
    stopSandbox: vi.fn(),
    destroySandbox: vi.fn(),
    getSandboxStatus: vi.fn(),
    uploadFiles: vi.fn(),
    downloadFile: vi.fn(),
    gitClone: vi.fn(),
    gitCheckout: vi.fn(),
    executeCommand: async () =>
      withSpan(
        { tracer: getTracer("test"), name: "nested-sandbox" },
        async () => ({ exitCode: 0, result: "PRIVATE_TOOL_RESULT" }),
      ),
  };
}
function model() {
  return replayModel({
    modelId: "mock-model-id",
    calls: [
      toolCallsCall([
        { id: "tool-one", name: "bash", input: { command: "PRIVATE_COMMAND" } },
      ]),
      replyCall("PRIVATE_REPLY"),
    ],
  }).model;
}

function attempt(input: {
  model: ReturnType<typeof model>;
  sessionId: string;
  turnId?: string;
}) {
  return new FakeHost({
    adapter: createAiSdkAdapter({ model: input.model }),
    attempt: attemptStart({
      thread: { mode: "fresh", providerThreadId: input.sessionId },
      sessionId: input.sessionId,
      projectId: "project",
      ...(input.turnId ? { turnId: input.turnId } : {}),
      input: { itemId: "item", text: "PRIVATE_PROMPT", attachments: [] },
    }),
    local: {
      sandbox: {
        provider: sandbox(),
        sandboxId: "sandbox",
        workingDirectory: "/workspace",
      },
      userId: "user",
    },
  });
}

function assertTraces() {
  const finished = spans.getFinishedSpans();
  const root = finished.find((span) => span.name === "invoke_agent ai-sdk");
  const tool = finished.find((span) => span.name === "execute_tool bash");
  expect(root).toBeDefined();
  for (const span of finished) {
    expect(span.attributes["catamorphic.project.id"]).toBe("project");
    expect(span.attributes["catamorphic.agent.session.id"]).toBe(
      root?.attributes["gen_ai.conversation.id"],
    );
    expect(span.attributes["gen_ai.conversation.id"]).toBe(
      root?.attributes["gen_ai.conversation.id"],
    );
    if (root?.attributes["catamorphic.agent.turn.id"])
      expect(span.attributes["catamorphic.agent.turn.id"]).toBe(
        root.attributes["catamorphic.agent.turn.id"],
      );
    expect(span.attributes["user.id"]).toBe(root?.attributes["user.id"]);
  }
  expect(
    finished.filter((span) => span.name === "chat mock-model-id"),
  ).toHaveLength(2);
  expect(tool?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
  expect(
    finished.find((span) => span.name === "nested-sandbox")?.parentSpanContext
      ?.spanId,
  ).toBe(tool?.spanContext().spanId);
  expect(
    finished.every(
      (span) => span.spanContext().traceId === root?.spanContext().traceId,
    ),
  ).toBe(true);
  expect(
    JSON.stringify(
      finished.map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
      })),
    ),
  ).not.toContain("PRIVATE_");
}
describe("built-in agent telemetry", () => {
  it("covers turns, each model call, tools, nested work and usage without content", async () => {
    await withTelemetryContext(
      {
        attributes: {
          "catamorphic.tenant.id": "tenant",
          "catamorphic.agent.turn.id": "durable-turn",
        },
      },
      async () => {
        await attempt({
          model: model(),
          sessionId: "session",
          turnId: "durable-turn",
        }).done;
      },
    );
    expect(
      spans
        .getFinishedSpans()
        .every(
          (span) =>
            span.attributes["catamorphic.agent.turn.id"] === "durable-turn",
        ),
    ).toBe(true);
    assertTraces();
    await meterProvider.forceFlush();
    const exported = metricExporter
      .getMetrics()
      .flatMap((item) => item.scopeMetrics)
      .flatMap((item) => item.metrics);
    expect(
      exported.find(
        (item) => item.descriptor.name === "gen_ai.client.token.usage",
      )?.dataPoints,
    ).toHaveLength(2);
    expect(JSON.stringify(exported)).not.toContain("PRIVATE_");
  });
  it("ends a failed streaming model span and records only the error type", async () => {
    await attempt({
      model: replayModel({
        modelId: "mock-model-id",
        calls: [streamErrorCall("PRIVATE_PROVIDER_BODY")],
      }).model,
      sessionId: "failed",
    }).done;
    const finished = spans.getFinishedSpans();
    expect(
      finished.find((span) => span.name === "invoke_agent ai-sdk")?.status.code,
    ).toBe(SpanStatusCode.ERROR);
    expect(
      finished.find((span) => span.name === "chat mock-model-id")?.status.code,
    ).toBe(SpanStatusCode.ERROR);
    expect(
      JSON.stringify(
        finished.map((span) => ({
          attributes: span.attributes,
          events: span.events,
          status: span.status,
        })),
      ),
    ).not.toContain("PRIVATE_");
  });
});

it("closes interrupted turn and model spans without marking cancellation as failure", async () => {
  const host = attempt({
    model: replayModel({
      modelId: "mock-model-id",
      calls: [hangingCall("PRIVATE_PARTIAL")],
    }).model,
    sessionId: "interrupted",
  });
  await host.waitFor((event) => event.type === "item.delta");
  host.send({ kind: "interrupt" });
  await host.done;
  await vi.waitFor(() => {
    const root = spans
      .getFinishedSpans()
      .find((span) => span.name === "invoke_agent ai-sdk");
    expect(root?.attributes["catamorphic.agent.outcome"]).toBe("cancelled");
    expect(root?.status.code).toBe(SpanStatusCode.UNSET);
    expect(
      spans
        .getFinishedSpans()
        .find((span) => span.name === "chat mock-model-id")?.status.code,
    ).toBe(SpanStatusCode.UNSET);
  });
});
