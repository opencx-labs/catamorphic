import {
  emitLog,
  getMeter,
  getTracer,
  SeverityNumber,
} from "@catamorphic/otel";
import {
  type Attributes,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { LanguageModel, Telemetry } from "ai";

const scope = "@catamorphic/ai-sdk";
const durationBuckets = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
];

/** GenAI development conventions, reviewed 2026-09-10. No content capture. */
export function agentTelemetry(args: {
  model: LanguageModel;
  sessionId: string;
  projectId?: string;
  turnId?: string;
  userId?: string;
}) {
  const tracer = getTracer(scope);
  const model =
    typeof args.model === "string" ? args.model : args.model.modelId;
  const provider =
    typeof args.model === "string"
      ? undefined
      : args.model.provider.split(".")[0];
  const agentAttributes: Attributes = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "ai-sdk",
    "gen_ai.request.model": model,
    ...(provider ? { "gen_ai.provider.name": provider } : {}),
  };
  const root = tracer.startSpan("invoke_agent ai-sdk", {
    attributes: {
      ...agentAttributes,
      ...(args.userId ? { "user.id": args.userId } : {}),
      "gen_ai.conversation.id": args.sessionId,
      "catamorphic.agent.session.id": args.sessionId,
      ...(args.projectId ? { "catamorphic.project.id": args.projectId } : {}),
      ...(args.turnId ? { "catamorphic.agent.turn.id": args.turnId } : {}),
    },
  });
  const rootContext = trace.setSpan(context.active(), root);
  const meter = context.with(rootContext, () => getMeter(scope));
  const histogram = (name: string, unit = "s", boundaries = durationBuckets) =>
    meter.createHistogram(name, {
      unit,
      advice: { explicitBucketBoundaries: boundaries },
    });
  const durations = histogram("gen_ai.client.operation.duration");
  const tokens = histogram(
    "gen_ai.client.token.usage",
    "{token}",
    [
      1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
      16777216, 67108864,
    ],
  );
  const firstChunk = histogram("gen_ai.client.operation.time_to_first_chunk");
  const toolDurations = histogram("gen_ai.execute_tool.duration");
  const invocationDuration = histogram("gen_ai.invoke_agent.duration");
  const began = performance.now();
  type Pending = { span: Span; started: number; attributes: Attributes };
  const calls = new Map<string, Pending>();
  const tools = new Map<string, Pending>();
  let failure: string | undefined;
  let ended = false;
  let modelCalls = 0;
  let toolCalls = 0;

  const fail = (span: Span, error: unknown) => {
    const type = error instanceof Error ? error.name : "_OTHER";
    // Provider exceptions can embed prompts, API keys, or request bodies.
    span.setAttribute("error.type", type);
    span.setStatus({ code: SpanStatusCode.ERROR });
    return type;
  };
  const finishPending = (
    pending: Pending,
    metric: ReturnType<typeof histogram>,
    error?: string,
  ) => {
    if (error) {
      pending.span.setAttribute("error.type", error);
      pending.span.setStatus({ code: SpanStatusCode.ERROR });
    }
    context.with(trace.setSpan(rootContext, pending.span), () =>
      metric.record((performance.now() - pending.started) / 1000, {
        ...pending.attributes,
        ...(error ? { "error.type": error } : {}),
      }),
    );
    pending.span.end();
  };
  const integration: Telemetry = {
    onLanguageModelCallStart(event) {
      const attributes: Attributes = {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": event.provider.split(".")[0] ?? event.provider,
        "gen_ai.request.model": event.modelId,
      };
      modelCalls += 1;
      calls.set(event.callId, {
        span: tracer.startSpan(
          `chat ${event.modelId}`,
          { kind: SpanKind.CLIENT, attributes },
          rootContext,
        ),
        started: performance.now(),
        attributes,
      });
    },
    async executeLanguageModelCall({ callId, execute }) {
      const pending = calls.get(callId);
      try {
        return await context.with(
          pending ? trace.setSpan(rootContext, pending.span) : rootContext,
          execute,
        );
      } catch (error) {
        if (pending && calls.delete(callId)) {
          finishPending(
            pending,
            durations,
            error instanceof Error && error.name === "AbortError"
              ? undefined
              : fail(pending.span, error),
          );
        }
        throw error;
      }
    },
    onLanguageModelCallEnd(event) {
      const pending = calls.get(event.callId);
      if (!pending) return;
      calls.delete(event.callId);
      pending.span.setAttributes({
        "gen_ai.response.id": event.responseId,
        "gen_ai.response.finish_reasons": [event.finishReason],
      });
      context.with(trace.setSpan(rootContext, pending.span), () => {
        for (const [kind, count] of [
          ["input", event.usage.inputTokens],
          ["output", event.usage.outputTokens],
        ] as const) {
          if (typeof count !== "number" || !Number.isFinite(count) || count < 0)
            continue;
          pending.span.setAttribute(`gen_ai.usage.${kind}_tokens`, count);
          tokens.record(count, {
            ...pending.attributes,
            "gen_ai.token.type": kind,
          });
        }
        for (const [attribute, count] of [
          [
            "gen_ai.usage.cache_read.input_tokens",
            event.usage.inputTokenDetails.cacheReadTokens,
          ],
          [
            "gen_ai.usage.cache_write.input_tokens",
            event.usage.inputTokenDetails.cacheWriteTokens,
          ],
          [
            "gen_ai.usage.reasoning.output_tokens",
            event.usage.outputTokenDetails.reasoningTokens,
          ],
        ] as const) {
          if (typeof count === "number" && Number.isFinite(count) && count >= 0)
            pending.span.setAttribute(attribute, count);
        }
        const first = event.performance.timeToFirstOutputMs;
        if (first !== undefined && Number.isFinite(first) && first >= 0)
          firstChunk.record(first / 1000, pending.attributes);
      });
      finishPending(pending, durations);
    },
    onToolExecutionStart(event) {
      toolCalls += 1;
      const attributes = {
        "gen_ai.tool.name": event.toolCall.toolName,
        "gen_ai.tool.type": "function",
        "gen_ai.agent.name": "ai-sdk",
      };
      tools.set(event.toolCall.toolCallId, {
        span: tracer.startSpan(
          `execute_tool ${event.toolCall.toolName}`,
          {
            attributes: {
              ...attributes,
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.call.id": event.toolCall.toolCallId,
            },
          },
          rootContext,
        ),
        started: performance.now(),
        attributes,
      });
    },
    executeTool({ toolCallId, execute }) {
      const span = tools.get(toolCallId)?.span;
      return context.with(
        span ? trace.setSpan(rootContext, span) : rootContext,
        execute,
      );
    },
    onToolExecutionEnd(event) {
      const pending = tools.get(event.toolCall.toolCallId);
      if (!pending) return;
      tools.delete(event.toolCall.toolCallId);
      const error =
        event.toolOutput.type === "tool-error"
          ? fail(pending.span, event.toolOutput.error)
          : undefined;
      finishPending(pending, toolDurations, error);
    },
  };
  return {
    settings: {
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
      integrations: integration,
    },
    run<T>(fn: () => T): T {
      return context.with(rootContext, fn);
    },
    fail(error: unknown) {
      failure = fail(root, error);
    },
    finish({ cancelled = false }: { cancelled?: boolean } = {}) {
      if (ended) return;
      ended = true;
      root.setAttribute(
        "catamorphic.agent.outcome",
        cancelled ? "cancelled" : failure ? "error" : "completed",
      );
      for (const pending of calls.values())
        finishPending(
          pending,
          durations,
          failure ?? (cancelled ? undefined : "_OTHER"),
        );
      for (const pending of tools.values())
        finishPending(
          pending,
          toolDurations,
          failure ?? (cancelled ? undefined : "_OTHER"),
        );
      calls.clear();
      tools.clear();
      context.with(rootContext, () => {
        emitLog({
          scope,
          body: "Agent turn settled",
          severity: failure ? SeverityNumber.ERROR : SeverityNumber.INFO,
          attributes: {
            "catamorphic.agent.outcome": cancelled
              ? "cancelled"
              : failure
                ? "error"
                : "completed",
            ...(failure ? { "error.type": failure } : {}),
          },
        });
        invocationDuration.record((performance.now() - began) / 1000, {
          ...agentAttributes,
          ...(failure ? { "error.type": failure } : {}),
        });
        histogram(
          "gen_ai.invoke_agent.model_calls",
          "{call}",
          [1, 2, 4, 8, 16, 32, 64, 128],
        ).record(modelCalls, { "gen_ai.agent.name": "ai-sdk" });
        histogram(
          "gen_ai.invoke_agent.tool_calls",
          "{call}",
          [1, 2, 4, 8, 16, 32, 64, 128],
        ).record(toolCalls, { "gen_ai.agent.name": "ai-sdk" });
      });
      root.end();
    },
  };
}
