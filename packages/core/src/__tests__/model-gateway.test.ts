import type { JsonObject } from "@catamorphic/db";
import { describe, expect, it } from "vitest";
import { ConnectionActionDeniedError } from "../services/connection-broker.js";
import type { ConnectionModelEndpoint } from "../services/connection-providers.js";
import type {
  ConnectionModelPolicy,
  ResolvedConnectionBinding,
} from "../services/connection-types.js";
import type { ExecutionAllocation } from "../services/execution-allocations-service.js";
import {
  type ModelGatewayResponse,
  ModelGatewayService,
  type ModelUsageRecord,
  modelAllowed,
  modelEndpointAction,
  SseUsageReader,
  usageFromJson,
} from "../services/model-gateway.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const GRANT = "grant-token";
const REAL_KEY = "sk-real";

function sse(events: readonly object[]): string {
  return events
    .map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

async function bodyText(response: ModelGatewayResponse): Promise<string> {
  if (response.body instanceof Uint8Array) return decoder.decode(response.body);
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return decoder.decode(Buffer.concat(chunks));
}

/** A stream that arrives in small pieces, as a real one does. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + 7));
      offset += 7;
    },
  });
}

function harness(options: {
  api: "anthropic" | "openai";
  policy?: ConnectionModelPolicy;
  deny?: string;
  usedOutputTokens?: number;
  upstream?: (url: string, init: RequestInit) => Response;
  sessionActive?: boolean;
}) {
  const binding: ResolvedConnectionBinding = {
    connectionId: "connection-1",
    alias: "model",
    providerKind: options.api,
    principalKind: "project_service",
    capabilities: ["model"],
    ...(options.policy ? { model: options.policy } : {}),
  };
  const allocation: ExecutionAllocation = {
    id: "allocation-1",
    projectId: "project-1",
    environmentName: "review",
    bindingId: "managed",
    workloadKind: "agent",
    rootWorkloadId: "session-1",
    workerNodeId: null,
    status: "active",
    releaseReason: null,
    createdAt: new Date().toISOString(),
    releasedAt: null,
    policy: {
      binding: {
        id: "managed",
        label: "Managed",
        trust: "managed",
        isolation: "sandbox",
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: [],
        resources: {},
      },
      requirements: { workload: "agent", topology: "controller" },
      connections: [binding],
    },
  };
  const endpoint: ConnectionModelEndpoint = {
    api: options.api,
    baseUrl:
      options.api === "anthropic"
        ? "https://api.anthropic.test"
        : "https://api.openai.test/v1",
    headers: (): Record<string, string> =>
      options.api === "anthropic"
        ? { "x-api-key": REAL_KEY }
        : { authorization: `Bearer ${REAL_KEY}` },
  };
  const upstreamCalls: Array<{ url: string; headers: Headers; body: string }> =
    [];
  const recorded: ModelUsageRecord[] = [];
  const audits: Array<{ outcome: string; metadata: unknown }> = [];
  const reviews: Array<{ action: string; input: JsonObject }> = [];
  const gateway = new ModelGatewayService({
    store: {
      session: async () => ({
        ownerId: "member-1",
        active: options.sessionActive ?? true,
        runningTurnId: "turn-1",
      }),
      recordUsage: async (record) => {
        recorded.push(record);
      },
      usage: async () =>
        options.usedOutputTokens === undefined
          ? undefined
          : { outputTokens: options.usedOutputTokens },
    },
    grants: {
      validate: async ({ token }) =>
        token === GRANT
          ? {
              tenantId: "tenant-1",
              projectId: "project-1",
              allocationId: "allocation-1",
              agentSessionId: "session-1",
              alias: "model",
              channel: "sandbox",
              capabilities: ["model"],
            }
          : null,
    },
    allocations: { get: async () => allocation },
    providers: {
      get: (kind) =>
        kind === options.api
          ? {
              kind,
              displayName: kind,
              model: endpoint,
              invoke: async () => null,
            }
          : undefined,
    },
    broker: {
      modelAccess: async (args) => {
        reviews.push({ action: args.action, input: args.input });
        if (options.deny) throw new ConnectionActionDeniedError(options.deny);
        return {
          endpoint,
          binding,
          headers: endpoint.headers({ material: new Uint8Array() }),
          audit: async (outcome, metadata) => {
            audits.push({ outcome, metadata });
          },
        };
      },
    },
    fetch: async (input, init) => {
      const url = String(input);
      upstreamCalls.push({
        url,
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
      });
      return (
        options.upstream?.(url, init ?? {}) ??
        new Response("{}", { headers: { "content-type": "application/json" } })
      );
    },
  });
  return { gateway, upstreamCalls, recorded, audits, reviews };
}

const anthropicStream = sse([
  {
    type: "message_start",
    message: {
      model: "claude-test-1",
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
        output_tokens: 1,
      },
    },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  },
  { type: "message_delta", usage: { output_tokens: 42 } },
  { type: "message_stop" },
]);

describe("model usage", () => {
  it("reads Anthropic streams and answers", () => {
    const reader = new SseUsageReader("anthropic");
    const bytes = encoder.encode(anthropicStream);
    for (let offset = 0; offset < bytes.length; offset += 5)
      reader.push(bytes.subarray(offset, offset + 5));
    reader.end();
    expect(reader.usage).toEqual({
      model: "claude-test-1",
      inputTokens: 120,
      cachedInputTokens: 30,
      cacheCreationTokens: 5,
      outputTokens: 42,
      reasoningTokens: 0,
    });
    expect(
      usageFromJson("anthropic", {
        model: "claude-test-1",
        usage: { input_tokens: 9, output_tokens: 4 },
      }),
    ).toMatchObject({
      model: "claude-test-1",
      inputTokens: 9,
      outputTokens: 4,
    });
  });

  it("reads OpenAI Responses and Chat Completions, streamed or not", () => {
    const responses = new SseUsageReader("openai");
    responses.push(
      encoder.encode(
        sse([
          { type: "response.output_text.delta", delta: "Hi" },
          {
            type: "response.completed",
            response: {
              model: "gpt-test",
              usage: {
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 40 },
                output_tokens: 20,
                output_tokens_details: { reasoning_tokens: 8 },
              },
            },
          },
        ]),
      ),
    );
    responses.end();
    expect(responses.usage).toEqual({
      model: "gpt-test",
      inputTokens: 60,
      cachedInputTokens: 40,
      cacheCreationTokens: 0,
      outputTokens: 20,
      reasoningTokens: 8,
    });
    const chat = new SseUsageReader("openai");
    chat.push(
      encoder.encode(
        `${sse([
          { model: "gpt-test", choices: [{ delta: { content: "Hi" } }] },
          {
            model: "gpt-test",
            choices: [],
            usage: {
              prompt_tokens: 50,
              completion_tokens: 7,
              prompt_tokens_details: { cached_tokens: 10 },
            },
          },
        ])}data: [DONE]\n\n`,
      ),
    );
    chat.end();
    expect(chat.usage).toMatchObject({
      inputTokens: 40,
      cachedInputTokens: 10,
      outputTokens: 7,
    });
    expect(
      usageFromJson("openai", {
        model: "gpt-test",
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    ).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });

  it("names endpoints and matches model patterns", () => {
    expect(
      modelEndpointAction({
        api: "anthropic",
        method: "POST",
        path: "/v1/messages",
      }),
    ).toBe("messages");
    expect(
      modelEndpointAction({
        api: "anthropic",
        method: "POST",
        path: "v1/messages/count_tokens",
      }),
    ).toBe("count_tokens");
    expect(
      modelEndpointAction({
        api: "openai",
        method: "POST",
        path: "chat/completions",
      }),
    ).toBe("chat.completions");
    expect(
      modelEndpointAction({ api: "openai", method: "POST", path: "files" }),
    ).toBeUndefined();
    expect(modelAllowed("claude-sonnet-5", ["claude-*"])).toBe(true);
    expect(modelAllowed("gpt-5", ["claude-*"])).toBe(false);
    expect(modelAllowed("anything", undefined)).toBe(true);
  });
});

describe("the model gateway", () => {
  const messages = (body: object, key: string | null = GRANT) => ({
    alias: "model",
    path: "v1/messages",
    method: "POST" as const,
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: encoder.encode(JSON.stringify(body)),
  });

  it("streams an Anthropic answer through with the real key and records its usage", async () => {
    const { gateway, upstreamCalls, recorded, audits, reviews } = harness({
      api: "anthropic",
      upstream: () =>
        new Response(streamOf(anthropicStream), {
          headers: {
            "content-type": "text/event-stream",
            "request-id": "req_1",
            "set-cookie": "no=thanks",
          },
        }),
    });
    const response = await gateway.handle(
      messages({
        model: "claude-test-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "a secret prompt" }],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.headers["request-id"]).toBe("req_1");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(await bodyText(response)).toBe(anthropicStream);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.url).toBe(
      "https://api.anthropic.test/v1/messages",
    );
    expect(upstreamCalls[0]?.headers.get("x-api-key")).toBe(REAL_KEY);
    expect(upstreamCalls[0]?.headers.get("anthropic-version")).toBe(
      "2023-06-01",
    );
    expect(recorded).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        endpoint: "messages",
        usage: expect.objectContaining({
          model: "claude-test-1",
          inputTokens: 120,
          outputTokens: 42,
        }),
      }),
    ]);
    expect(audits.map((audit) => audit.outcome)).toEqual(["allowed"]);
    // Guards and audits see the call, never the prompt.
    expect(reviews[0]).toEqual({
      action: "messages",
      input: {
        provider: "anthropic",
        endpoint: "messages",
        model: "claude-test-1",
        stream: true,
        maxOutputTokens: 64,
      },
    });
    expect(JSON.stringify([reviews, audits, recorded])).not.toContain(
      "secret prompt",
    );
  });

  it("forwards OpenAI Chat Completions with a bearer and asks streams for usage", async () => {
    const { gateway, upstreamCalls, recorded } = harness({
      api: "openai",
      upstream: () =>
        new Response(
          streamOf(
            sse([
              {
                model: "gpt-test",
                choices: [],
                usage: { prompt_tokens: 5, completion_tokens: 3 },
              },
            ]),
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const response = await gateway.handle({
      alias: "model",
      path: "chat/completions",
      method: "POST",
      headers: { authorization: `Bearer ${GRANT}` },
      body: encoder.encode(
        JSON.stringify({ model: "gpt-test", stream: true, messages: [] }),
      ),
    });
    expect(response.status).toBe(200);
    await bodyText(response);
    expect(upstreamCalls[0]?.url).toBe(
      "https://api.openai.test/v1/chat/completions",
    );
    expect(upstreamCalls[0]?.headers.get("authorization")).toBe(
      `Bearer ${REAL_KEY}`,
    );
    expect(JSON.parse(upstreamCalls[0]?.body ?? "{}").stream_options).toEqual({
      include_usage: true,
    });
    expect(recorded[0]?.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 3,
    });
  });

  it("refuses callers without a valid grant in the API's own error shape", async () => {
    const { gateway, upstreamCalls } = harness({ api: "anthropic" });
    const missing = await gateway.handle(messages({ model: "x" }, null));
    expect(missing.status).toBe(401);
    expect(JSON.parse(await bodyText(missing))).toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Send this session's grant as the API key",
      },
    });
    expect(
      (await gateway.handle(messages({ model: "x" }, REAL_KEY))).status,
    ).toBe(401);
    const closed = harness({ api: "anthropic", sessionActive: false });
    expect((await closed.gateway.handle(messages({ model: "x" }))).status).toBe(
      401,
    );
    const openai = harness({ api: "openai" });
    const refused = await openai.gateway.handle({
      alias: "model",
      path: "responses",
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: encoder.encode("{}"),
    });
    expect(JSON.parse(await bodyText(refused)).error.code).toBe(
      "invalid_api_key",
    );
    expect(upstreamCalls).toHaveLength(0);
  });

  it("refuses models outside the allowlist, guard denials, spent budgets, and unknown endpoints", async () => {
    const allow = harness({
      api: "anthropic",
      policy: { allow: ["claude-*"] },
    });
    const other = await allow.gateway.handle(messages({ model: "gpt-5" }));
    expect(other.status).toBe(403);
    expect(await bodyText(other)).toContain("permission_error");
    expect(allow.upstreamCalls).toHaveLength(0);

    const guarded = harness({ api: "anthropic", deny: "no models at night" });
    const denied = await guarded.gateway.handle(
      messages({ model: "claude-test-1" }),
    );
    expect(denied.status).toBe(403);
    expect(await bodyText(denied)).toContain("Refused: no models at night");
    expect(guarded.upstreamCalls).toHaveLength(0);

    const spent = harness({
      api: "anthropic",
      policy: { maxOutputTokensPerTurn: 100 },
      usedOutputTokens: 100,
    });
    const over = await spent.gateway.handle(
      messages({ model: "claude-test-1" }),
    );
    expect(over.status).toBe(403);
    expect(await bodyText(over)).toContain("budget of 100 output tokens");
    // Counting tokens spends none.
    const counted = await spent.gateway.handle({
      ...messages({ model: "claude-test-1" }),
      path: "v1/messages/count_tokens",
    });
    expect(counted.status).toBe(200);
    await bodyText(counted);
    expect(spent.recorded).toHaveLength(0);
    expect(spent.audits.map((audit) => audit.outcome)).toEqual(["allowed"]);

    const unknown = await allow.gateway.handle({
      ...messages({ model: "claude-test-1" }),
      path: "v1/files",
    });
    expect(unknown.status).toBe(404);
  });

  it("passes the provider's own errors through and audits them", async () => {
    const { gateway, audits, recorded } = harness({
      api: "anthropic",
      upstream: () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "slow down" },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "3" },
          },
        ),
    });
    const response = await gateway.handle(messages({ model: "claude-test-1" }));
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("3");
    expect(await bodyText(response)).toContain("slow down");
    expect(audits).toEqual([{ outcome: "error", metadata: { status: 429 } }]);
    expect(recorded).toHaveLength(0);
  });
});
