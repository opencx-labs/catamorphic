import http from "node:http";
import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";

/** One content block a scripted model reply streams. */
export type ScriptedBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: JsonObject };

/** What the scripted model answers one Messages API request with. */
export type ScriptedReply =
  | {
      blocks: ScriptedBlock[];
      /** Defaults to `tool_use` when a block calls a tool, else `end_turn`. */
      stopReason?: "end_turn" | "tool_use";
      /** Held open between the first text delta and the rest (interrupts). */
      holdMs?: number;
    }
  | {
      /** An HTTP error the CLI receives instead of a message. */
      error: { status: number; type: string; message: string };
    };

export interface ScriptedRequest {
  /** 0-based order of the request among `/v1/messages` calls. */
  index: number;
  body: JsonObject;
}

export interface ScriptedModel {
  /** Base URL for `ANTHROPIC_BASE_URL`. */
  url: string;
  requests: ScriptedRequest[];
  close(): Promise<void>;
}

/**
 * A loopback Anthropic Messages API the real Claude Code CLI talks to when
 * recording replay transcripts and in native tests. `reply` scripts the
 * model: it sees each request (its messages, tools) and says what the
 * assistant streams back.
 */
export async function startScriptedModel(input: {
  reply: (request: ScriptedRequest) => ScriptedReply | Promise<ScriptedReply>;
}): Promise<ScriptedModel> {
  const requests: ScriptedRequest[] = [];
  let messageCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (!req.url?.startsWith("/v1/messages") || req.url.includes("count")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const parsed: JsonValue = JSON.parse(
      Buffer.concat(chunks).toString() || "{}",
    );
    const body: JsonObject =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    const request = { index: requests.length, body };
    requests.push(request);
    let reply: ScriptedReply;
    try {
      reply = await input.reply(request);
    } catch (error) {
      reply = {
        error: {
          status: 500,
          type: "api_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if ("error" in reply) {
      res.writeHead(reply.error.status, {
        "content-type": "application/json",
        ...(reply.error.status === 429 ? { "retry-after": "0" } : {}),
      });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: reply.error.type, message: reply.error.message },
        }),
      );
      return;
    }
    messageCount += 1;
    const stopReason =
      reply.stopReason ??
      (reply.blocks.some((block) => block.type === "tool_use")
        ? "tool_use"
        : "end_turn");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: JsonObject) =>
      res.write(
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    send({
      type: "message_start",
      message: {
        id: `msg_scripted_${messageCount}`,
        type: "message",
        role: "assistant",
        model:
          typeof body.model === "string" ? body.model : "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 1,
        },
      },
    });
    let held = false;
    for (const [index, block] of reply.blocks.entries()) {
      if (block.type === "text") {
        send({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        });
        for (const [part, text] of halves(block.text).entries()) {
          send({
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text },
          });
          if (part === 0 && reply.holdMs && !held) {
            held = true;
            await new Promise((resolve) => setTimeout(resolve, reply.holdMs));
            if (res.destroyed) return;
          }
        }
      } else if (block.type === "thinking") {
        send({
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        });
        send({
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        });
        send({
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: "scripted-signature" },
        });
      } else {
        send({
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        });
        send({
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        });
      }
      send({ type: "content_block_stop", index });
    }
    send({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    send({ type: "message_stop" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The scripted model has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function halves(text: string): string[] {
  if (text.length < 2) return [text];
  const half = Math.ceil(text.length / 2);
  return [text.slice(0, half), text.slice(half)];
}

/**
 * The environment that points the real CLI at a scripted model and nothing
 * else: an isolated config home, a fixture key, and proxies that refuse
 * every other host.
 */
export function scriptedModelEnv(input: {
  url: string;
  home: string;
}): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: input.home,
    ANTHROPIC_API_KEY: "fixture-key",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_MODEL: "",
    ANTHROPIC_BASE_URL: input.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  };
}
