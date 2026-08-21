import { describe, expect, it } from "vitest";
import {
  createCodexScanState,
  dedupeWithinFile,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  totalTokens,
} from "./usage-transcripts.js";

const claudeLine = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-20T04:05:13.944Z",
    sessionId: "5a128faa-1111-2222-3333-444455556666",
    requestId: "req_1",
    cwd: "/Users/me/project",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-fable-5",
      content: [{ type: "text" }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 13595,
        cache_read_input_tokens: 24274,
        output_tokens: 618,
        output_tokens_details: { thinking_tokens: 469 },
        service_tier: "standard",
      },
    },
    ...overrides,
  });

describe("parseClaudeLine", () => {
  it("maps the real assistant record shape", () => {
    const record = parseClaudeLine(claudeLine());
    expect(record).toMatchObject({
      model: "claude-fable-5",
      sessionId: "5a128faa-1111-2222-3333-444455556666",
      dedupeKey: "msg_1:req_1",
      tokens: {
        inputTokens: 2,
        cachedInputTokens: 24274,
        cacheCreationTokens: 13595,
        outputTokens: 618,
        reasoningTokens: 469,
      },
    });
    expect(totalTokens(record!.tokens)).toBe(2 + 24274 + 13595 + 618);
  });

  it("ignores non-assistant lines, missing models, bad timestamps, torn JSON", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "user" }))).toBeNull();
    expect(
      parseClaudeLine(
        claudeLine({
          message: { usage: { input_tokens: 5 }, model: "" },
        }),
      ),
    ).toBeNull();
    expect(parseClaudeLine(claudeLine({ timestamp: "not-a-date" }))).toBeNull();
    expect(parseClaudeLine('{"type":"assistant","mess')).toBeNull();
  });

  it("dedupes per-content-block copies within a file, first record wins", () => {
    // One message written as two records (a text block and a tool_use
    // block), each repeating the parent message's whole usage object.
    const a = parseClaudeLine(claudeLine())!;
    const b = parseClaudeLine(claudeLine())!;
    expect(dedupeWithinFile([a, b])).toHaveLength(1);
  });

  it("keeps records that have no dedupe identity", () => {
    const bare = parseClaudeLine(
      claudeLine({
        requestId: undefined,
        message: {
          model: "claude-fable-5",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    )!;
    expect(bare.dedupeKey).toBeNull();
    expect(dedupeWithinFile([bare, { ...bare }])).toHaveLength(2);
  });
});

const codexMeta = (
  payload: Record<string, unknown> = {},
  ts = "2026-08-20T10:00:00.000Z",
) =>
  JSON.stringify({
    type: "session_meta",
    timestamp: ts,
    payload: { type: "session_meta", id: "019fbbc1-aaaa", ...payload },
  });
const codexTurnContext = (
  model = "gpt-5.6-sol",
  ts = "2026-08-20T10:00:01.000Z",
) =>
  JSON.stringify({
    type: "turn_context",
    timestamp: ts,
    payload: { type: "turn_context", model },
  });
const codexCount = (last: Record<string, unknown>, ts: string) =>
  JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: { last_token_usage: last, model_context_window: 258400 },
    },
  });

const usageDelta = {
  input_tokens: 19239,
  cached_input_tokens: 11008,
  cache_write_input_tokens: 0,
  output_tokens: 299,
  reasoning_output_tokens: 116,
};

describe("parseCodexLine", () => {
  it("attributes deltas to the model carried forward from turn_context", () => {
    const state = createCodexScanState();
    expect(parseCodexLine(codexMeta(), state)).toBeNull();
    expect(parseCodexLine(codexTurnContext(), state)).toBeNull();
    const record = parseCodexLine(
      codexCount(usageDelta, "2026-08-20T10:00:05.000Z"),
      state,
    );
    expect(record).toMatchObject({
      model: "gpt-5.6-sol",
      sessionId: "019fbbc1-aaaa",
      dedupeKey: null,
      tokens: {
        // input_tokens is inclusive of the cached portion.
        inputTokens: 19239 - 11008,
        cachedInputTokens: 11008,
        outputTokens: 299,
        reasoningTokens: 116,
      },
    });
  });

  it("drops a token_count that precedes any turn_context", () => {
    const state = createCodexScanState();
    expect(
      parseCodexLine(codexCount(usageDelta, "2026-08-20T10:00:05.000Z"), state),
    ).toBeNull();
  });

  it("drops consecutive duplicate deltas but counts a changed one", () => {
    const state = createCodexScanState();
    parseCodexLine(codexTurnContext(), state);
    const first = parseCodexLine(
      codexCount(usageDelta, "2026-08-20T10:00:05.000Z"),
      state,
    );
    const repeat = parseCodexLine(
      codexCount(usageDelta, "2026-08-20T10:00:06.000Z"),
      state,
    );
    const changed = parseCodexLine(
      codexCount(
        { ...usageDelta, output_tokens: 300 },
        "2026-08-20T10:00:07.000Z",
      ),
      state,
    );
    expect(first).not.toBeNull();
    expect(repeat).toBeNull();
    expect(changed).not.toBeNull();
  });

  it("keeps only the first session_meta: forks replay ancestors' metas", () => {
    const state = createCodexScanState();
    parseCodexLine(codexMeta(), state);
    parseCodexLine(codexMeta({ id: "ancestor" }), state);
    parseCodexLine(codexTurnContext(), state);
    const record = parseCodexLine(
      codexCount(usageDelta, "2026-08-20T10:00:05.000Z"),
      state,
    )!;
    expect(record.sessionId).toBe("019fbbc1-aaaa");
  });

  it("suppresses the fork-copy burst and resumes on the first real gap", () => {
    const state = createCodexScanState();
    parseCodexLine(
      codexMeta({ forked_from_id: "parent" }, "2026-08-20T10:00:00.000Z"),
      state,
    );
    parseCodexLine(
      codexTurnContext("gpt-5.6-sol", "2026-08-20T10:00:00.010Z"),
      state,
    );
    // Copied history: re-stamped within milliseconds of the fork instant.
    const copy1 = parseCodexLine(
      codexCount(usageDelta, "2026-08-20T10:00:00.020Z"),
      state,
    );
    const copy2 = parseCodexLine(
      codexCount(
        { ...usageDelta, output_tokens: 4 },
        "2026-08-20T10:00:00.050Z",
      ),
      state,
    );
    // The fork's first real usage lands seconds later.
    const real = parseCodexLine(
      codexCount(
        { ...usageDelta, output_tokens: 7 },
        "2026-08-20T10:00:06.000Z",
      ),
      state,
    );
    expect(copy1).toBeNull();
    expect(copy2).toBeNull();
    expect(real).not.toBeNull();
  });
});

describe("parseCodexLine with outer-type-only lines", () => {
  it("reads current rollouts where the payload does not repeat its type", () => {
    // Current Codex writes {"type":"turn_context","payload":{model,...}}
    // with no payload.type; only the outer record names the kind.
    const state = createCodexScanState();
    parseCodexLine(
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-07T19:32:43.000Z",
        payload: { id: "019fdd11-dc44", cwd: "/x", model_provider: "openai" },
      }),
      state,
    );
    parseCodexLine(
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-07T19:32:44.000Z",
        payload: { turn_id: "t1", model: "gpt-5.6-terra", cwd: "/x" },
      }),
      state,
    );
    const record = parseCodexLine(
      codexCount(usageDelta, "2026-08-07T19:32:50.000Z"),
      state,
    );
    expect(record).toMatchObject({
      model: "gpt-5.6-terra",
      sessionId: "019fdd11-dc44",
    });
  });
});

describe("mightCarryUsage", () => {
  it("prefilters by provider-specific substrings", () => {
    expect(mightCarryUsage('{"message":{"usage":{}}}', "claude")).toBe(true);
    expect(mightCarryUsage('{"type":"user"}', "claude")).toBe(false);
    expect(mightCarryUsage('{"payload":{"type":"token_count"}}', "codex")).toBe(
      true,
    );
    expect(
      mightCarryUsage('{"payload":{"type":"turn_context"}}', "codex"),
    ).toBe(true);
    expect(
      mightCarryUsage('{"payload":{"type":"response_item"}}', "codex"),
    ).toBe(false);
  });
});

describe("the per-file pipeline end to end", () => {
  it("dedupes claude per-content-block copies across a whole file", () => {
    const records = [claudeLine(), claudeLine()]
      .filter((line) => mightCarryUsage(line, "claude"))
      .flatMap((line) => parseClaudeLine(line) ?? []);
    expect(records).toHaveLength(2);
    expect(dedupeWithinFile(records)).toHaveLength(1);
  });

  it("reduces the codex meta+context+count sequence to one record", () => {
    const state = createCodexScanState();
    const records = [
      codexMeta(),
      codexTurnContext(),
      codexCount(usageDelta, "2026-08-20T10:00:05.000Z"),
    ]
      .filter((line) => mightCarryUsage(line, "codex"))
      .flatMap((line) => parseCodexLine(line, state) ?? []);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      model: "gpt-5.6-sol",
      sessionId: "019fbbc1-aaaa",
    });
  });
});
