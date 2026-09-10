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
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AiSdkCodingAgent } from "../ai-sdk-agent.js";
import { AiSdkAgentRuntime } from "../ai-sdk-runtime.js";

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
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
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
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            {
              type: "tool-call" as const,
              toolCallId: "tool-one",
              toolName: "bash",
              input: '{"command":"PRIVATE_COMMAND"}',
            },
            {
              type: "finish" as const,
              finishReason: { unified: "tool-calls" as const, raw: undefined },
              usage,
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "text" },
            { type: "text-delta" as const, id: "text", delta: "PRIVATE_REPLY" },
            { type: "text-end" as const, id: "text" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: undefined },
              usage,
            },
          ],
        }),
      },
    ],
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
  it("covers legacy harness turns, each model call, tools, nested work and usage without content", async () => {
    const agent = new AiSdkCodingAgent({
      model: model(),
      sandboxProvider: sandbox(),
    });
    const session = await agent.startSession({
      sessionId: "session",
      projectId: "project",
      userId: "user",
      sandboxId: "sandbox",
      workingDirectory: "/workspace",
    });
    await withTelemetryContext(
      {
        attributes: {
          "catamorphic.tenant.id": "tenant",
          "catamorphic.agent.turn.id": "durable-turn",
        },
      },
      async () => {
        for await (const _event of agent.sendMessage(
          session,
          "PRIVATE_PROMPT",
        )) {
          /* consume */
        }
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
    await agent.dispose(session);
  });
  it("covers long-lived runtime turns through the same telemetry integration", async () => {
    const runtime = new AiSdkAgentRuntime({
      model: model(),
      sandboxProvider: sandbox(),
    });
    await runtime.startSession({
      sessionId: "runtime",
      projectId: "project",
      allocationId: "allocation",
      workingDirectory: "/workspace",
    });
    await runtime.startTurn({
      sessionId: "runtime",
      message: { role: "user", content: "PRIVATE_PROMPT" },
    });
    for await (const event of runtime.subscribe({ sessionId: "runtime" }))
      if (event.type === "turn.completed" || event.type === "turn.failed")
        break;
    assertTraces();
    await runtime.stopSession({ sessionId: "runtime" });
  });
  it("ends a failed streaming model span and records only the error type", async () => {
    const agent = new AiSdkCodingAgent({
      model: new MockLanguageModelV4({
        doStream: {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "error" as const,
                error: new Error("PRIVATE_PROVIDER_BODY"),
              },
            ],
          }),
        },
      }),
      sandboxProvider: sandbox(),
    });
    const session = await agent.startSession({
      sessionId: "failed",
      projectId: "project",
      userId: "user",
      sandboxId: "sandbox",
      workingDirectory: "/workspace",
    });
    for await (const _event of agent.sendMessage(session, "PRIVATE_PROMPT")) {
      /* consume */
    }
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
    await agent.dispose(session);
  });
});

it("closes interrupted runtime and model spans without marking cancellation as failure", async () => {
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runtime = new AiSdkAgentRuntime({
    sandboxProvider: sandbox(),
    model: new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream<never>({
          start(controller) {
            abortSignal?.addEventListener(
              "abort",
              () => controller.error(new Error("cancelled")),
              { once: true },
            );
            started?.();
          },
        }),
      }),
    }),
  });
  await runtime.startSession({
    sessionId: "interrupted",
    projectId: "project",
    allocationId: "allocation",
    workingDirectory: "/workspace",
  });
  const turn = await runtime.startTurn({
    sessionId: "interrupted",
    message: { role: "user", content: "PRIVATE_PROMPT" },
  });
  await ready;
  await runtime.interruptTurn({
    sessionId: "interrupted",
    turnId: turn.turnId,
  });
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
  await runtime.stopSession({ sessionId: "interrupted" });
});
