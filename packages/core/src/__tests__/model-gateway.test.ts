import { createHash } from "node:crypto";
import type { JsonObject } from "@catamorphic/db";
import { describe, expect, it } from "vitest";
import {
  ConnectionActionDeniedError,
  ConnectionActionRefusedError,
} from "../services/connection-broker.js";
import type { ModelRequestRewrite } from "../services/connection-guards.js";
import type { ConnectionModelEndpoint } from "../services/connection-providers.js";
import type {
  ConnectionModelPolicy,
  ResolvedConnectionBinding,
} from "../services/connection-types.js";
import { ConnectionUnavailableError } from "../services/connections-service.js";
import {
  dotPathSegment,
  type LiveModelGrant,
  type ModelCallUsage,
  type ModelGatewayResponse,
  ModelGatewayService,
  type ModelUsageRecord,
  modelAllowed,
  modelRequestPath,
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

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
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

function until(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await until(5);
  expect(check()).toBe(true);
}

function harness(options: {
  api: "anthropic" | "openai";
  policy?: ConnectionModelPolicy;
  deny?: string;
  /** Whether a guard reviews model calls (so the body's model is read). */
  guarded?: boolean;
  upstream?: (url: string, init: RequestInit) => Response;
  sessionActive?: boolean;
  /** What the broker throws instead of resolving the alias. */
  fail?: Error;
  /** The session's running turn; false when none runs. */
  runningTurn?: string | false;
  /** How long a usage or audit write takes. */
  writeDelayMs?: number;
  /** The host's rewrites of request bodies (ADR 0256). */
  rewrites?: ModelRequestRewrite[];
  /** The connection's override and paths (ADR 0256). */
  override?: ConnectionModelEndpoint["override"];
  paths?: readonly string[];
  /** How long a rewrite may take. */
  rewriteTimeoutMs?: number;
}) {
  const binding: ResolvedConnectionBinding = {
    connectionId: "connection-1",
    alias: "model",
    providerKind: options.api,
    principalKind: "project_service",
    capabilities: ["model"],
    ...(options.policy ? { model: options.policy } : {}),
  };
  const state = { revoked: false, revision: 1, key: REAL_KEY, now: 0 };
  const endpoint: ConnectionModelEndpoint = {
    api: options.api,
    baseUrl:
      options.api === "anthropic"
        ? "https://api.anthropic.test"
        : "https://api.openai.test/v1",
    headers: (): Record<string, string> =>
      options.api === "anthropic"
        ? { "x-api-key": state.key }
        : { authorization: `Bearer ${state.key}` },
    ...(options.override ? { override: options.override } : {}),
    ...(options.paths ? { paths: options.paths } : {}),
  };
  const upstreamCalls: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: Uint8Array | undefined;
  }> = [];
  const recorded: Array<ModelUsageRecord & { usage: ModelCallUsage }> = [];
  /** Calls whose usage row is open: their answer has not settled yet. */
  const open = new Set<string>();
  const audits: Array<{ outcome: string; metadata: unknown }> = [];
  const reviews: Array<{ action: string; input: JsonObject }> = [];
  const refusals: Array<{ action: string; reason: string }> = [];
  const counts = { resolved: 0, liveGrant: 0 };
  const slow = () =>
    options.writeDelayMs ? until(options.writeDelayMs) : Promise.resolve();
  const gateway = new ModelGatewayService({
    now: () => state.now,
    ...(options.rewrites ? { rewrites: options.rewrites } : {}),
    ...(options.rewriteTimeoutMs
      ? { rewriteTimeoutMs: options.rewriteTimeoutMs }
      : {}),
    store: {
      liveGrant: async ({ token }): Promise<LiveModelGrant | undefined> => {
        counts.liveGrant++;
        if (token !== GRANT || state.revoked) return undefined;
        return {
          id: "grant-1",
          tenantId: "tenant-1",
          allocationId: "allocation-1",
          agentSessionId: "session-1",
          alias: "model",
          session: {
            ownerId: "member-1",
            active: options.sessionActive ?? true,
          },
          connection: {
            id: "connection-1",
            revision: state.revision,
            status: "ready",
            expiresAt: null,
          },
        };
      },
      runningTurn: async () =>
        options.runningTurn === false
          ? undefined
          : (options.runningTurn ?? "turn-1"),
      openUsage: async () => {
        const id = String(open.size + recorded.length + 1);
        open.add(id);
        return id;
      },
      recordUsage: async ({ record, usage, openId }) => {
        await slow();
        recorded.push({ ...record, usage });
        if (openId) open.delete(openId);
      },
      openCalls: async () => open.size,
      usage: async () => undefined,
    },
    broker: {
      reviews: () => Boolean(options.guarded || options.deny),
      auditModelRefusal: async ({ action, reason }) => {
        refusals.push({ action, reason });
      },
      modelEndpoint: async () => {
        counts.resolved++;
        if (options.fail) throw options.fail;
        return {
          endpoint,
          binding,
          projectId: "project-1",
          headers: endpoint.headers({ material: new Uint8Array() }),
        };
      },
      reviewModelCall: async (args) => {
        reviews.push({ action: args.action, input: args.input });
        if (options.deny) throw new ConnectionActionDeniedError(options.deny);
        return async (outcome, metadata) => {
          await slow();
          audits.push({ outcome, metadata });
        };
      },
    },
    fetch: async (input, init) => {
      const url = String(input);
      const body = init?.body;
      upstreamCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: body instanceof Uint8Array ? body : undefined,
      });
      return (
        options.upstream?.(url, init ?? {}) ??
        new Response("{}", { headers: { "content-type": "application/json" } })
      );
    },
  });
  return {
    gateway,
    state,
    counts,
    upstreamCalls,
    recorded,
    audits,
    reviews,
    refusals,
  };
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

  it("matches model patterns and keeps paths below the base URL", () => {
    expect(modelAllowed("claude-sonnet-5", ["claude-*"])).toBe(true);
    expect(modelAllowed("gpt-5", ["claude-*"])).toBe(false);
    expect(modelAllowed("anything", undefined)).toBe(true);
    expect(modelRequestPath("/v1/messages")).toBe("v1/messages");
    expect(modelRequestPath("v1/models/claude-x@2025:latest")).toBe(
      "v1/models/claude-x@2025:latest",
    );
    expect(modelRequestPath("v1/files/")).toBe("v1/files/");
    for (const escaping of [
      "",
      "../secrets",
      "v1/../../x",
      "v1/%2e%2e/x",
      "v1/%2E%2e/x",
      "v1/a%2Fb",
      "v1/a%5Cb",
      "v1//x",
      "v1/./x",
      "v1/a\\b",
      "v1/%zz",
      "v1/a%00",
      "http://evil.test/x",
      // Servlet containers strip path parameters, then resolve the dots.
      "v1/..;/admin",
      "v1/..;x=1/admin",
      "v1/%2e%2e;/admin",
      "v1/%2e%2e%3b/admin",
      "v1/%2E%2E%3Bjsessionid=1/admin",
      "v1/.;/x",
    ])
      expect(modelRequestPath(escaping), escaping).toBeNull();
    // A parameter on an ordinary segment is the provider's business.
    expect(modelRequestPath("v1/files;version=2/x")).toBe(
      "v1/files;version=2/x",
    );
    expect(dotPathSegment("..;")).toBe(true);
    expect(dotPathSegment("...;")).toBe(false);
  });
});

describe("the model gateway", () => {
  const messages = (body: object, key: string | null = GRANT) => ({
    alias: "model",
    path: "v1/messages",
    method: "POST",
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
      guarded: true,
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
    await waitFor(() => recorded.length === 1 && audits.length === 1);
    expect(recorded).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        endpoint: "v1/messages",
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
      action: "POST v1/messages",
      input: { provider: "anthropic", model: "claude-test-1", stream: true },
    });
    expect(JSON.stringify([reviews, audits, recorded])).not.toContain(
      "secret prompt",
    );
  });

  it("forwards the request body byte for byte, JSON or not", async () => {
    const { gateway, upstreamCalls } = harness({ api: "openai" });
    // Odd spacing, key order and a field the gateway never names.
    const json = encoder.encode(
      '{ "stream":true,"model" : "gpt-test","messages":[],"max_tokens":9 }',
    );
    const binary = new Uint8Array([0, 255, 1, 128, 13, 10, 45, 45]);
    for (const [path, body] of [
      ["chat/completions", json],
      ["audio/transcriptions", binary],
    ] as const) {
      const response = await gateway.handle({
        alias: "model",
        path,
        method: "POST",
        headers: {
          authorization: `Bearer ${GRANT}`,
          "content-type": "application/octet-stream",
        },
        body,
      });
      expect(response.status).toBe(200);
      await bodyText(response);
    }
    expect(upstreamCalls.map((call) => digest(call.body ?? ""))).toEqual([
      digest(json),
      digest(binary),
    ]);
    // No stream_options.include_usage, no output limit: nothing added.
    expect(decoder.decode(upstreamCalls[0]?.body)).not.toContain(
      "include_usage",
    );
  });

  it("passes any path, method and unknown header through, and strips the denied ones both ways", async () => {
    const { gateway, upstreamCalls, recorded, audits } = harness({
      api: "anthropic",
      upstream: () =>
        new Response('{"id":"claude-x"}', {
          headers: {
            "content-type": "application/json",
            "x-provider-thing": "kept",
            "set-cookie": "session=1",
            "alt-svc": 'h3=":443"',
            "content-encoding": "gzip",
            "x-forwarded-for": "10.0.0.1",
          },
        }),
    });
    const response = await gateway.handle({
      alias: "model",
      path: "v1/models/claude-x",
      query: "beta=true",
      method: "GET",
      headers: {
        "x-api-key": GRANT,
        "anthropic-beta": "new-thing-2027",
        "x-custom-harness": "yes",
        host: "gateway.local",
        cookie: "secret=1",
        connection: "keep-alive, x-hop",
        "x-hop": "per-connection",
        "keep-alive": "timeout=5",
        "proxy-authorization": "Basic eA==",
        "x-forwarded-for": "10.0.0.2",
        "transfer-encoding": "chunked",
        upgrade: "h2c",
        te: "trailers",
      },
    });
    expect(response.status).toBe(200);
    expect(await bodyText(response)).toBe('{"id":"claude-x"}');
    const call = upstreamCalls[0];
    expect(call?.url).toBe(
      "https://api.anthropic.test/v1/models/claude-x?beta=true",
    );
    expect(call?.method).toBe("GET");
    expect(call?.body).toBeUndefined();
    expect(call?.headers.get("anthropic-beta")).toBe("new-thing-2027");
    expect(call?.headers.get("x-custom-harness")).toBe("yes");
    expect(call?.headers.get("x-api-key")).toBe(REAL_KEY);
    for (const denied of [
      "host",
      "cookie",
      "connection",
      "x-hop",
      "keep-alive",
      "proxy-authorization",
      "x-forwarded-for",
      "transfer-encoding",
      "upgrade",
      "te",
      "authorization",
    ])
      expect(call?.headers.get(denied), denied).toBeNull();
    expect(response.headers["x-provider-thing"]).toBe("kept");
    for (const denied of [
      "set-cookie",
      "alt-svc",
      "content-encoding",
      "x-forwarded-for",
    ])
      expect(response.headers[denied], denied).toBeUndefined();
    // Reading spends nothing: audited, not counted.
    await waitFor(() => audits.length === 1);
    expect(recorded).toHaveLength(0);
  });

  it("refuses paths that would leave the base URL", async () => {
    const { gateway, upstreamCalls } = harness({ api: "openai" });
    for (const path of ["../admin", "v1/%2e%2e/admin", "a%2F..%2Fb"]) {
      const response = await gateway.handle({
        alias: "model",
        path,
        method: "GET",
        headers: { authorization: `Bearer ${GRANT}` },
      });
      expect(response.status, path).toBe(404);
      expect(JSON.parse(await bodyText(response)).error.type).toBe(
        "not_found_error",
      );
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  it("records OpenAI Responses usage, and zero for an answer it cannot read", async () => {
    const { gateway, recorded } = harness({
      api: "openai",
      upstream: (url) =>
        url.endsWith("/responses")
          ? new Response(
              JSON.stringify({
                model: "gpt-test",
                usage: { input_tokens: 11, output_tokens: 5 },
              }),
              { headers: { "content-type": "application/json" } },
            )
          : new Response("plain words", {
              headers: { "content-type": "text/plain" },
            }),
    });
    for (const path of ["responses", "something/new"]) {
      const response = await gateway.handle({
        alias: "model",
        path,
        method: "POST",
        headers: { authorization: `Bearer ${GRANT}` },
        body: encoder.encode('{"model":"gpt-test"}'),
      });
      await bodyText(response);
    }
    await waitFor(() => recorded.length === 2);
    expect(recorded.map((row) => row.usage)).toEqual([
      expect.objectContaining({
        model: "gpt-test",
        inputTokens: 11,
        outputTokens: 5,
      }),
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    ]);
  });

  it("records an Anthropic JSON answer's usage", async () => {
    const { gateway, recorded } = harness({
      api: "anthropic",
      upstream: () =>
        Response.json({
          model: "claude-test-1",
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
    });
    await bodyText(await gateway.handle(messages({ model: "claude-test-1" })));
    await waitFor(() => recorded.length === 1);
    expect(recorded[0]?.usage).toMatchObject({
      model: "claude-test-1",
      inputTokens: 7,
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

  it("refuses models outside the allowlist and guard denials", async () => {
    const allow = harness({
      api: "anthropic",
      policy: { allow: ["claude-*"] },
    });
    const other = await allow.gateway.handle(messages({ model: "gpt-5" }));
    expect(other.status).toBe(403);
    expect(await bodyText(other)).toContain("permission_error");
    const allowed = await allow.gateway.handle(
      messages({ model: "claude-test-1" }),
    );
    expect(allowed.status).toBe(200);
    await bodyText(allowed);
    expect(allow.upstreamCalls).toHaveLength(1);

    const guarded = harness({ api: "anthropic", deny: "no models at night" });
    const denied = await guarded.gateway.handle(
      messages({ model: "claude-test-1" }),
    );
    expect(denied.status).toBe(403);
    expect(await bodyText(denied)).toContain("Refused: no models at night");
    expect(guarded.upstreamCalls).toHaveLength(0);
  });

  it("requires a POST to name its model when the binding allows only some", async () => {
    const allow = harness({
      api: "anthropic",
      policy: { allow: ["claude-*"] },
    });
    const unnamed = await allow.gateway.handle(messages({ max_tokens: 5 }));
    expect(unnamed.status).toBe(400);
    const numeric = await allow.gateway.handle(messages({ model: 5 }));
    expect(numeric.status).toBe(400);
    const notJson = await allow.gateway.handle({
      ...messages({}),
      body: encoder.encode("model=claude-test-1"),
    });
    expect(notJson.status).toBe(400);
    expect(allow.upstreamCalls).toHaveLength(0);
    // Reads name no model.
    const listed = await allow.gateway.handle({
      ...messages({}),
      method: "GET",
      path: "v1/models",
      body: undefined,
    });
    expect(listed.status).toBe(200);
    await bodyText(listed);
  });

  it("serves calls between turns, recorded without a turn", async () => {
    const idle = harness({ api: "anthropic", runningTurn: false });
    const response = await idle.gateway.handle(
      messages({ model: "claude-test-1", max_tokens: 10 }),
    );
    expect(response.status).toBe(200);
    await bodyText(response);
    await waitFor(() => idle.recorded.length === 1);
    expect(idle.recorded[0]?.turnId).toBeNull();
  });

  it("reuses a resolved alias across calls, and resolves it again after a rotation", async () => {
    const { gateway, state, counts, upstreamCalls } = harness({
      api: "anthropic",
    });
    for (let call = 0; call < 3; call++)
      await bodyText(await gateway.handle(messages({ model: "claude-x" })));
    // The grant is checked every call; the key is decrypted once.
    expect(counts.liveGrant).toBe(3);
    expect(counts.resolved).toBe(1);
    // A rotated key is a new revision: the next call uses it.
    state.revision = 2;
    state.key = "sk-rotated";
    await bodyText(await gateway.handle(messages({ model: "claude-x" })));
    expect(counts.resolved).toBe(2);
    expect(upstreamCalls.at(-1)?.headers.get("x-api-key")).toBe("sk-rotated");
    // And the cache lasts 30 seconds.
    state.now += 31_000;
    await bodyText(await gateway.handle(messages({ model: "claude-x" })));
    expect(counts.resolved).toBe(3);
  });

  it("stops serving a revoked grant on its next call", async () => {
    const { gateway, state, upstreamCalls } = harness({ api: "anthropic" });
    await bodyText(await gateway.handle(messages({ model: "claude-x" })));
    state.revoked = true;
    const refused = await gateway.handle(messages({ model: "claude-x" }));
    expect(refused.status).toBe(401);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("ends the answer without waiting on usage or audit writes", async () => {
    const { gateway, recorded, audits } = harness({
      api: "anthropic",
      writeDelayMs: 400,
      upstream: () =>
        new Response(streamOf(anthropicStream), {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const started = Date.now();
    const response = await gateway.handle(
      messages({ model: "claude-test-1", stream: true }),
    );
    expect(await bodyText(response)).toBe(anthropicStream);
    expect(Date.now() - started).toBeLessThan(200);
    expect(recorded).toHaveLength(0);
    await waitFor(() => recorded.length === 1 && audits.length === 1);
    // A session's usage waits for its writes still in flight.
    const writes = harness({
      api: "anthropic",
      writeDelayMs: 100,
      upstream: () =>
        new Response(streamOf(anthropicStream), {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    await bodyText(
      await writes.gateway.handle(messages({ model: "claude-test-1" })),
    );
    await until(5);
    await writes.gateway.sessionUsage({ sessionId: "session-1" });
    expect(writes.recorded).toHaveLength(1);
  });

  it("records what a stream the caller abandons reported", async () => {
    const { gateway, recorded, audits } = harness({
      api: "anthropic",
      upstream: () =>
        new Response(streamOf(anthropicStream), {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const response = await gateway.handle(
      messages({ model: "claude-test-1", max_tokens: 4096, stream: true }),
    );
    if (response.body instanceof Uint8Array) throw new Error("not a stream");
    const iterator = response.body[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await waitFor(() => recorded.length === 1 && audits.length === 1);
    expect(recorded[0]?.usage.outputTokens).toBeLessThan(4096);
    expect(audits[0]?.metadata).toMatchObject({ interrupted: true });
  });

  it("never answers a refusal with a retryable status", async () => {
    for (const fail of [
      new ConnectionUnavailableError("model", "Connection is unavailable"),
      new Error("database went away"),
    ]) {
      const { gateway } = harness({ api: "anthropic", fail });
      const response = await gateway.handle(
        messages({ model: "claude-test-1" }),
      );
      expect(response.status).toBe(403);
      expect(JSON.parse(await bodyText(response)).error.type).toBe(
        "permission_error",
      );
    }
  });

  it("admits a request by its grant before reading the body, and checks it once", async () => {
    const { gateway, counts } = harness({ api: "anthropic" });
    const request = messages({ model: "claude-x" });
    const result = await gateway.admit(request);
    if (!("admitted" in result)) throw new Error("expected an admission");
    await bodyText(
      await gateway.handle({ ...request, admitted: result.admitted }),
    );
    expect(counts.liveGrant).toBe(1);
    // An admission this gateway did not issue is checked again.
    await bodyText(
      await gateway.handle({ ...request, admitted: { ...result.admitted } }),
    );
    expect(counts.liveGrant).toBe(2);
    const refused = await gateway.admit({
      ...request,
      headers: { "x-api-key": "nope" },
    });
    expect("refused" in refused && refused.refused.status).toBe(401);
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
    await waitFor(() => audits.length === 1);
    expect(audits).toEqual([{ outcome: "error", metadata: { status: 429 } }]);
    expect(recorded).toHaveLength(0);
  });
});

describe("model request rewrites (ADR 0256)", () => {
  const chat = (
    body: string | Uint8Array,
    headers: Record<string, string> = {},
    method = "POST",
    path = "chat/completions",
  ) => ({
    alias: "model",
    path,
    query: "trace=1",
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${GRANT}`,
      ...headers,
    },
    body: typeof body === "string" ? encoder.encode(body) : body,
  });
  /** Pins OpenRouter's providers, whatever the caller asked for. */
  const pin: ModelRequestRewrite = {
    name: "pin providers",
    rewrite: ({ body }) => ({
      ...body,
      provider: { only: ["together"], allow_fallbacks: false },
    }),
  };
  const sent = (call: { body: Uint8Array | undefined } | undefined) =>
    JSON.parse(decoder.decode(call?.body ?? new Uint8Array()));

  it("sends the provider the rewritten body, once, as our own JSON, and tells the rewrite who calls", async () => {
    const seen: unknown[] = [];
    const { gateway, upstreamCalls } = harness({
      api: "openai",
      rewrites: [
        {
          name: "record",
          rewrite: (request) => {
            seen.push({
              path: request.path,
              query: request.query,
              header: request.headers["x-trace"],
              context: request.context,
            });
            return pin.rewrite(request);
          },
        },
      ],
    });
    // Two `provider` fields: parsers disagree on which one wins, so only
    // the gateway's serialization may reach the provider.
    const response = await gateway.handle(
      chat(
        '{"model":"m","provider":{"only":["deepinfra"]},"provider":{"order":["chutes"]}}',
        { "content-type": "text/plain", "x-trace": "t" },
      ),
    );
    expect(response.status).toBe(200);
    await bodyText(response);
    const text = decoder.decode(upstreamCalls[0]?.body ?? new Uint8Array());
    expect(text.match(/"provider"/g)).toHaveLength(1);
    expect(sent(upstreamCalls[0])).toEqual({
      model: "m",
      provider: { only: ["together"], allow_fallbacks: false },
    });
    expect(upstreamCalls[0]?.headers.get("content-type")).toBe(
      "application/json",
    );
    expect(seen).toEqual([
      {
        path: "chat/completions",
        query: "trace=1",
        header: "t",
        context: {
          tenantId: "tenant-1",
          projectId: "project-1",
          alias: "model",
          providerKind: "openai",
          connectionId: "connection-1",
          principalKind: "project_service",
          sessionId: "session-1",
        },
      },
    ]);
  });

  it("applies the host's rewrites in order, only to their kinds, and the connection's override last", async () => {
    const { gateway, upstreamCalls } = harness({
      api: "openai",
      rewrites: [
        {
          name: "first",
          rewrite: ({ body }) => ({ ...body, user: "a", trail: ["first"] }),
        },
        {
          name: "anthropic only",
          kinds: ["anthropic"],
          rewrite: ({ body }) => ({ ...body, trail: ["never"] }),
        },
        {
          name: "second",
          rewrite: ({ body }) => ({
            ...body,
            trail: [...(Array.isArray(body.trail) ? body.trail : []), "second"],
            provider: { only: ["chutes"] },
          }),
        },
      ],
      override: { provider: { only: ["together"] }, user: null },
    });
    const response = await gateway.handle(chat('{"model":"m"}'));
    await bodyText(response);
    expect(sent(upstreamCalls[0])).toEqual({
      model: "m",
      trail: ["first", "second"],
      provider: { only: ["together"] },
    });
  });

  it("judges the body it sends: the model, every fallback, and no variant a pattern does not name", async () => {
    const { gateway, upstreamCalls, reviews, refusals } = harness({
      api: "openai",
      policy: { allow: ["deepseek/*"] },
      guarded: true,
      rewrites: [
        {
          name: "force model",
          rewrite: ({ body }) => ({ ...body, model: "deepseek/v4-flash" }),
        },
      ],
    });
    const forced = await gateway.handle(chat('{"model":"openai/gpt-x"}'));
    expect(forced.status).toBe(200);
    await bodyText(forced);
    expect(sent(upstreamCalls[0]).model).toBe("deepseek/v4-flash");
    expect(reviews[0]?.input).toMatchObject({ model: "deepseek/v4-flash" });

    const plain = harness({
      api: "openai",
      policy: { allow: ["deepseek/*"] },
      override: { provider: { only: ["together"] } },
    });
    for (const body of [
      '{"model":"deepseek/v4-flash","models":["meta-llama/llama-5"]}',
      '{"model":"deepseek/v4-flash:online"}',
      '{"model":"@preset/anything"}',
      // Two `model` fields: the one judged is the one sent.
      '{"model":"deepseek/v4-flash","model":"openai/gpt-x"}',
    ]) {
      const refused = await plain.gateway.handle(chat(body));
      expect(refused.status).toBe(403);
      await bodyText(refused);
    }
    expect(plain.upstreamCalls).toHaveLength(0);
    expect(plain.refusals).toHaveLength(4);
    expect(refusals).toHaveLength(0);
  });

  it("refuses what it cannot rewrite rather than forwarding it unrewritten, and audits it", async () => {
    const { gateway, upstreamCalls, refusals } = harness({
      api: "openai",
      rewrites: [pin],
    });
    for (const request of [
      chat("not json"),
      chat('["a","list"]'),
      chat('{"model":"m"}', { "content-encoding": "gzip" }),
      chat(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])),
    ]) {
      const response = await gateway.handle(request);
      expect(response.status).toBe(400);
      expect(await bodyText(response)).toContain("invalid_request_error");
    }
    // A body on another method is reviewed too.
    const put = await gateway.handle(chat("not json", {}, "PUT"));
    expect(put.status).toBe(400);
    await bodyText(put);
    expect(upstreamCalls).toHaveLength(0);
    expect(refusals).toHaveLength(5);
    expect(refusals[0]).toMatchObject({ action: "POST chat/completions" });
    // Nothing to rewrite: no body, or an empty one, passes as before.
    const models = await gateway.handle({
      alias: "model",
      path: "models",
      method: "GET",
      headers: { authorization: `Bearer ${GRANT}` },
    });
    expect(models.status).toBe(200);
    await bodyText(models);
    const empty = await gateway.handle(chat(""));
    expect(empty.status).toBe(200);
    await bodyText(empty);
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[1]?.body).toEqual(new Uint8Array());
  });

  it("refuses a call the rewrite refuses, fails on, answers wrongly, or takes too long over", async () => {
    const refusing = harness({
      api: "openai",
      rewrites: [
        {
          name: "refuse",
          rewrite: () => {
            throw new ConnectionActionRefusedError(
              "Only pinned providers serve this",
            );
          },
        },
      ],
    });
    const refused = await refusing.gateway.handle(chat('{"model":"m"}'));
    expect(refused.status).toBe(403);
    expect(await bodyText(refused)).toContain(
      "Only pinned providers serve this",
    );
    const cases: Array<[ModelRequestRewrite["rewrite"], string]> = [
      [
        () => {
          throw new Error("boom");
        },
        "could not review this request",
      ],
      // @ts-expect-error: a rewrite that answers with something else
      [() => ["not", "an", "object"], "could not review this request"],
      [() => new Promise<never>(() => {}), "in time"],
    ];
    for (const [rewrite, message] of cases) {
      const broken = harness({
        api: "openai",
        rewrites: [{ name: "broken", rewrite }],
        rewriteTimeoutMs: 20,
      });
      const failed = await broken.gateway.handle(chat('{"model":"m"}'));
      expect(failed.status).toBe(403);
      expect(await bodyText(failed)).toContain(message);
      expect(broken.upstreamCalls).toHaveLength(0);
    }
    expect(refusing.upstreamCalls).toHaveLength(0);
  });

  it("serves only the paths a connection names", async () => {
    const { gateway, upstreamCalls, refusals } = harness({
      api: "openai",
      paths: ["/chat/completions", "/models"],
    });
    const preset = await gateway.handle(
      chat('{"model":"m"}', {}, "POST", "presets/team/chat/completions"),
    );
    expect(preset.status).toBe(404);
    await bodyText(preset);
    const prefix = await gateway.handle(
      chat('{"model":"m"}', {}, "POST", "chat/completionsx"),
    );
    expect(prefix.status).toBe(404);
    await bodyText(prefix);
    const allowed = await gateway.handle(chat('{"model":"m"}'));
    expect(allowed.status).toBe(200);
    await bodyText(allowed);
    expect(upstreamCalls).toHaveLength(1);
    expect(refusals).toHaveLength(2);
  });
});
