#!/usr/bin/env bun
/**
 * A stand-in for the Claude Code CLI (TODO.md "fake claude"), speaking the
 * Claude Agent SDK's stdio protocol well enough for real turns: it answers
 * `initialize`, takes a user message, calls the Anthropic Messages API at
 * `ANTHROPIC_BASE_URL` with the key its `apiKeyHelper` prints, runs the
 * `Bash` tool uses the model asks for in its working directory, sends the
 * results back, and reports the answer and usage as a `result`. Tests put
 * it on a sandbox's PATH as `claude`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function emit(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (const [index, arg] of args.entries()) {
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

const sessionId = flag("--session-id") ?? flag("--resume") ?? randomUUID();
const model = flag("--model") ?? "claude-test";

/** The key: `ANTHROPIC_API_KEY`, else what the settings' helper prints. */
function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const settings = flag("--settings");
  const helper = settings
    ? record(JSON.parse(settings)).apiKeyHelper
    : undefined;
  if (typeof helper !== "string") return "";
  return execFileSync("sh", ["-c", helper], { encoding: "utf8" }).trim();
}

interface Answer {
  content: Json[];
  usage: { input_tokens: number; output_tokens: number };
}

/** One streamed Messages call, read back into content blocks and usage. */
async function callModel(messages: Json[]): Promise<Answer> {
  const response = await fetch(
    `${process.env.ANTHROPIC_BASE_URL ?? ""}/v1/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey(),
      },
      body: JSON.stringify({ model, max_tokens: 1024, stream: true, messages }),
    },
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(`API Error: ${response.status} ${text.trim()}`);
  const content: Json[] = [];
  const partial = new Map<number, string>();
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const event = record(JSON.parse(line.slice(5)));
    const index = typeof event.index === "number" ? event.index : 0;
    if (event.type === "message_start") {
      const start = record(record(event.message).usage);
      usage.input_tokens = Number(start.input_tokens ?? 0);
    } else if (event.type === "content_block_start") {
      content[index] = { ...record(event.content_block) };
    } else if (event.type === "content_block_delta") {
      const delta = record(event.delta);
      const block = content[index] ?? {};
      if (delta.type === "text_delta")
        block.text = `${String(block.text ?? "")}${String(delta.text ?? "")}`;
      if (delta.type === "input_json_delta")
        partial.set(
          index,
          `${partial.get(index) ?? ""}${String(delta.partial_json ?? "")}`,
        );
      content[index] = block;
    } else if (event.type === "message_delta") {
      usage.output_tokens = Number(record(event.usage).output_tokens ?? 0);
    }
  }
  for (const [index, json] of partial)
    if (content[index]) content[index].input = JSON.parse(json || "{}");
  return { content, usage };
}

async function turn(prompt: string): Promise<void> {
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    uuid: randomUUID(),
    cwd: process.cwd(),
    model,
    tools: ["Bash"],
    mcp_servers: [],
    permissionMode: "acceptEdits",
    apiKeySource: "apiKeyHelper",
    slash_commands: [],
    output_style: "default",
  });
  const messages: Json[] = [{ role: "user", content: prompt }];
  const total = { input_tokens: 0, output_tokens: 0 };
  let answer = "";
  try {
    for (let step = 0; step < 8; step++) {
      const reply = await callModel(messages);
      total.input_tokens += reply.usage.input_tokens;
      total.output_tokens += reply.usage.output_tokens;
      emit({
        type: "assistant",
        session_id: sessionId,
        uuid: randomUUID(),
        parent_tool_use_id: null,
        message: {
          id: `msg_${randomUUID()}`,
          role: "assistant",
          model,
          content: reply.content,
          usage: reply.usage,
        },
      });
      messages.push({ role: "assistant", content: reply.content });
      const uses = reply.content.filter((block) => block.type === "tool_use");
      if (uses.length === 0) {
        answer = reply.content
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .join("");
        break;
      }
      const results = uses.map((use) => {
        const command = String(record(use.input).command ?? "");
        const run = spawnSync("bash", ["-c", command], { encoding: "utf8" });
        return {
          type: "tool_result",
          tool_use_id: use.id,
          content: `${run.stdout}${run.stderr}`,
          is_error: run.status !== 0,
        };
      });
      emit({
        type: "user",
        session_id: sessionId,
        uuid: randomUUID(),
        parent_tool_use_id: null,
        message: { role: "user", content: results },
      });
      messages.push({ role: "user", content: results });
    }
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: answer,
      session_id: sessionId,
      uuid: randomUUID(),
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        ...total,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {
        [model]: {
          inputTokens: total.input_tokens,
          outputTokens: total.output_tokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200_000,
          costUSD: 0,
        },
      },
      permission_denials: [],
    });
  } catch (error) {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: sessionId,
      uuid: randomUUID(),
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { ...total },
      modelUsage: {},
      permission_denials: [],
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
}

function promptOf(message: Json): string {
  const content = record(message.message).content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .map((block) => {
          const text = record(block).text;
          return typeof text === "string" ? text : "";
        })
        .join("")
    : "";
}

let pending = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = record(JSON.parse(line));
  if (message.type === "control_request") {
    const request = record(message.request);
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response:
          request.subtype === "initialize"
            ? {
                commands: [],
                models: [],
                account: {},
                output_style: "default",
                available_output_styles: ["default"],
              }
            : {},
      },
    });
    return;
  }
  if (message.type === "user") {
    const prompt = promptOf(message);
    pending = pending.then(() => turn(prompt));
  }
});
lines.on("close", () => {
  void pending.then(() => process.exit(0));
});
