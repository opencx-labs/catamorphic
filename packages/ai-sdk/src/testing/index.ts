/**
 * Replay harness for the built-in agent (ADR 0197: tests replay real
 * transcripts). A {@link ModelTranscript} is what the model provider
 * streamed, call by call, as AI SDK provider stream parts; {@link replayModel}
 * plays it back as a `LanguageModel`, so a test replaces only the model
 * transport and runs the adapter, its tools, the runner and the host for
 * real. {@link recordModel} captures a transcript from a live model.
 *
 * Transcripts are JSON: record one against a real provider once, save it
 * beside the test, and replay it in every run.
 */
import { APICallError, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type CallOptions = Parameters<MockLanguageModelV4["doStream"]>[0];

/** One part of a provider's stream, exactly as the model transport yields it. */
export type ModelStreamPart =
  StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

/** What the model received for one call: the prompt, tools and settings. */
export type ModelCallOptions = CallOptions;

export type ModelCall =
  | {
      /** The parts the provider streamed for this call. */
      parts: ModelStreamPart[];
      /**
       * Keep the stream open after the parts until the call is aborted, as
       * a provider does while the model is still writing.
       */
      hang?: boolean;
    }
  | {
      /** The provider refused the request before streaming anything. */
      reject: {
        message: string;
        statusCode?: number;
        responseBody?: string;
        isRetryable?: boolean;
      };
    };

export interface ModelTranscript {
  /** The model id the replay reports; `replay-model` by default. */
  modelId?: string;
  provider?: string;
  calls: ModelCall[];
}

export interface ReplayModel {
  /** The model to hand the adapter. */
  model: MockLanguageModelV4;
  /** What each call received, in order. */
  readonly calls: ModelCallOptions[];
  /** Calls the transcript holds that nobody made yet. */
  remaining(): number;
}

/**
 * A model that plays a transcript back. A call past its end fails the
 * test with a clear message instead of hanging. `beforeCall` runs before
 * a call streams: a test can hold the model there (to steer, to
 * interrupt) or inspect its prompt.
 */
export function replayModel(
  transcript: ModelTranscript,
  hooks?: {
    beforeCall?: (input: {
      index: number;
      options: ModelCallOptions;
    }) => void | Promise<void>;
  },
): ReplayModel {
  let next = 0;
  const calls: ModelCallOptions[] = [];
  const model = new MockLanguageModelV4({
    provider: transcript.provider ?? "replay",
    modelId: transcript.modelId ?? "replay-model",
    doStream: async (options) => {
      const index = next;
      next += 1;
      calls.push(options);
      await hooks?.beforeCall?.({ index, options });
      const call = transcript.calls[index];
      if (!call)
        throw new Error(
          `The model was called ${index + 1} times; the transcript holds ${transcript.calls.length} calls.`,
        );
      if ("reject" in call)
        throw new APICallError({
          message: call.reject.message,
          url: "https://replay.invalid/v1/messages",
          requestBodyValues: {},
          ...(call.reject.statusCode !== undefined
            ? { statusCode: call.reject.statusCode }
            : {}),
          ...(call.reject.responseBody !== undefined
            ? { responseBody: call.reject.responseBody }
            : {}),
          ...(call.reject.isRetryable !== undefined
            ? { isRetryable: call.reject.isRetryable }
            : {}),
        });
      return { stream: partStream(call.parts, call.hang, options.abortSignal) };
    },
  });
  return {
    model,
    calls,
    remaining: () => Math.max(0, transcript.calls.length - next),
  };
}

function partStream(
  parts: readonly ModelStreamPart[],
  hang: boolean | undefined,
  signal: AbortSignal | undefined,
): ReadableStream<ModelStreamPart> {
  let index = 0;
  return new ReadableStream<ModelStreamPart>({
    async pull(controller) {
      const part = parts[index];
      index += 1;
      if (part) {
        // A tick between parts, as a network stream has.
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.enqueue(structuredClone(part));
        return;
      }
      if (!hang) {
        controller.close();
        return;
      }
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      controller.error(signal?.reason ?? new Error("aborted"));
    },
  });
}

/**
 * Wrap a live model so every call's streamed parts are kept: run a scenario
 * against a real provider once, then save `transcript()` as the test's
 * fixture.
 */
export function recordModel(
  model: Parameters<typeof wrapLanguageModel>[0]["model"],
): {
  model: ReturnType<typeof wrapLanguageModel>;
  transcript(): ModelTranscript;
} {
  const calls: ModelCall[] = [];
  const wrapped = wrapLanguageModel({
    model,
    middleware: {
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        const parts: ModelStreamPart[] = [];
        calls.push({ parts });
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<ModelStreamPart, ModelStreamPart>({
              transform(part, controller) {
                parts.push(structuredClone(part));
                controller.enqueue(part);
              },
            }),
          ),
        };
      },
    },
  });
  return {
    model: wrapped,
    transcript: () => ({
      modelId: wrapped.modelId,
      provider: wrapped.provider,
      calls: structuredClone(calls),
    }),
  };
}

// ---------------------------------------------------------------------------
// Builders for hand-written transcripts

export interface StepUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

const DEFAULT_USAGE: Required<StepUsage> = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};

/** The `finish` part a provider ends a call with. */
export function finishPart(input: {
  reason: "stop" | "tool-calls" | "length" | "error" | "other";
  usage?: StepUsage;
}): ModelStreamPart {
  const usage = { ...DEFAULT_USAGE, ...input.usage };
  return {
    type: "finish",
    finishReason: { unified: input.reason, raw: undefined },
    usage: {
      inputTokens: {
        total: usage.input,
        noCache: usage.input - usage.cacheRead - usage.cacheWrite,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
      },
      outputTokens: {
        total: usage.output,
        text: usage.output - usage.reasoning,
        reasoning: usage.reasoning,
      },
    },
  };
}

/** A text block, streamed in `chunks` deltas. */
export function textParts(
  text: string,
  options?: { id?: string; chunks?: number },
): ModelStreamPart[] {
  const id = options?.id ?? "text-0";
  return [
    { type: "text-start", id },
    ...split(text, options?.chunks ?? 2).map(
      (delta): ModelStreamPart => ({ type: "text-delta", id, delta }),
    ),
    { type: "text-end", id },
  ];
}

/** A reasoning block (a summary opening with a bold heading becomes status). */
export function reasoningParts(
  text: string,
  options?: { id?: string },
): ModelStreamPart[] {
  const id = options?.id ?? "reasoning-0";
  return [
    { type: "reasoning-start", id },
    { type: "reasoning-delta", id, delta: text },
    { type: "reasoning-end", id },
  ];
}

/** One tool call, its input as the model wrote it. */
export function toolCallPart(input: {
  id: string;
  name: string;
  input: unknown;
}): ModelStreamPart {
  return {
    type: "tool-call",
    toolCallId: input.id,
    toolName: input.name,
    input: JSON.stringify(input.input),
  };
}

/** A call that answers in text and stops. */
export function replyCall(
  text: string,
  options?: { reasoning?: string; usage?: StepUsage; hang?: boolean },
): ModelCall {
  return {
    parts: [
      { type: "stream-start", warnings: [] },
      ...(options?.reasoning ? reasoningParts(options.reasoning) : []),
      ...textParts(text),
      ...(options?.hang
        ? []
        : [finishPart({ reason: "stop", ...usageOf(options) })]),
    ],
    ...(options?.hang ? { hang: true } : {}),
  };
}

/** A call that (optionally says something and) calls tools. */
export function toolCallsCall(
  calls: Array<{ id: string; name: string; input: unknown }>,
  options?: { text?: string; usage?: StepUsage },
): ModelCall {
  return {
    parts: [
      { type: "stream-start", warnings: [] },
      ...(options?.text ? textParts(options.text) : []),
      ...calls.map(toolCallPart),
      finishPart({ reason: "tool-calls", ...usageOf(options) }),
    ],
  };
}

/** A call the provider refuses (a 429, a 401, a 400 about reasoning). */
export function rejectedCall(
  reject: Extract<ModelCall, { reject: unknown }>["reject"],
): ModelCall {
  return { reject };
}

/** A call whose stream fails after it started. */
export function streamErrorCall(message: string): ModelCall {
  return {
    parts: [
      { type: "stream-start", warnings: [] },
      { type: "error", error: { message } },
    ],
  };
}

/** A call that starts writing and never finishes until it is aborted. */
export function hangingCall(text = ""): ModelCall {
  return {
    parts: [
      { type: "stream-start", warnings: [] },
      ...(text ? [{ type: "text-start" as const, id: "text-0" }] : []),
      ...(text
        ? [{ type: "text-delta" as const, id: "text-0", delta: text }]
        : []),
    ],
    hang: true,
  };
}

function usageOf(options?: { usage?: StepUsage }): { usage?: StepUsage } {
  return options?.usage ? { usage: options.usage } : {};
}

function split(text: string, chunks: number): string[] {
  if (chunks <= 1 || text.length < chunks) return [text];
  const size = Math.ceil(text.length / chunks);
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += size)
    parts.push(text.slice(start, start + size));
  return parts;
}
