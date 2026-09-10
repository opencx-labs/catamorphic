import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { ClaudeCodeAgent } from "../claude-code-agent.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "pinned Claude Code consumes blocking=%s question answers in one query",
  async (blocking) => {
    const home = await mkdtemp(path.join(tmpdir(), "claude-questions-"));
    const asked = deferred();
    const continued = deferred();
    const answered = deferred();
    const sent = deferred();
    const steered = deferred();
    let steeredBeforeResponse = false;
    const requests: string[] = [];
    let pending = false;
    let acknowledged = 0;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (
        !req.url?.startsWith("/v1/messages") ||
        req.url.includes("count_tokens")
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      requests.push(Buffer.concat(chunks).toString());
      const count = requests.length;
      if (!blocking && count === 3) {
        steered.resolve();
      }
      if (!blocking && count === 2) {
        continued.resolve();
        await sent.promise;
        steeredBeforeResponse = await Promise.race([
          steered.promise.then(() => true),
          delay(2000).then(() => false),
        ]);
      }
      const block =
        count === 1
          ? {
              type: "tool_use",
              id: "tool_ask_1",
              name: "mcp__workspace__ask_user",
              input: {
                ...(blocking ? {} : { blocking }),
                questions: [
                  {
                    question: "Which theme?",
                    header: "Theme",
                    options: [],
                    multiSelect: false,
                  },
                ],
              },
            }
          : { type: "text", text: "Independent work completed" };
      const events = [
        {
          type: "message_start",
          message: {
            id: `msg_${count}`,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 2, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block:
            block.type === "tool_use"
              ? { ...block, input: {} }
              : { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta:
            block.type === "tool_use"
              ? {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.input),
                }
              : { type: "text_delta", text: block.text },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: {
            stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: { output_tokens: 3 },
        },
        { type: "message_stop" },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture port");
    const agent = new ClaudeCodeAgent({
      model: "claude-sonnet-4-5",
      memory: false,
      env: {
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: "fixture-key",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
      },
    });
    const session = await agent.startSession({
      projectId: "fixture-project",
      sessionId: crypto.randomUUID(),
      userId: "fixture-user",
      sandboxId: "local",
      workingDirectory: home,
    });
    const events: Array<{ type: string; content?: string }> = [];
    const timeout = setTimeout(() => {
      void agent.dispose(session);
      answered.resolve();
      sent.resolve();
      steered.resolve();
    }, 20000);
    const run = (async () => {
      for await (const event of agent.sendMessage(
        session,
        "Ask my preference and continue independent work",
        {
          askQuestion: async (input) => {
            expect(input.blocking).toBe(blocking);
            asked.resolve();
            if (blocking) {
              await answered.promise;
              return "Choose orange";
            }
            return "Question saved. Continue independent work.";
          },
          readPendingMessages: async () => {
            if (!pending) return [];
            sent.resolve();
            return [{ id: "answer-1", content: "Choose orange" }];
          },
          acknowledgeMessages: async ({ ids }) => {
            expect(ids).toEqual(["answer-1"]);
            acknowledged++;
            pending = false;
          },
        },
      ))
        events.push(event);
    })();
    try {
      await Promise.race([
        asked.promise,
        run.then(() => {
          throw new Error(`No question: ${JSON.stringify(events)}`);
        }),
      ]);
      if (blocking) {
        expect(requests).toHaveLength(1);
        answered.resolve();
      } else {
        await Promise.race([
          continued.promise,
          run.then(() => {
            throw new Error(`No independent work: ${JSON.stringify(events)}`);
          }),
        ]);
        pending = true;
      }
      await run;
      expect(events.filter((event) => event.type === "done")).toHaveLength(1);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(requests.at(-1)).toContain("Choose orange");
      expect(acknowledged).toBe(blocking ? 0 : 1);
      if (!blocking) expect(steeredBeforeResponse).toBe(true);
    } finally {
      clearTimeout(timeout);
      answered.resolve();
      sent.resolve();
      await agent.dispose(session);
      await run.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
