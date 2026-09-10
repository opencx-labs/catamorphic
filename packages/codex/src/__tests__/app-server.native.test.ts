import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexAppServer } from "../app-server.js";

it.each(["accept", "decline", "cancel"] as const)(
  "pinned CLI forwards %s elicitation, media, and a resumed turn through app-server",
  async (action) => {
    const home = await mkdtemp(
      path.join(tmpdir(), "catamorphic-codex-native-"),
    );
    const abort = new AbortController();
    const requests: unknown[] = [];
    const authorizations: Array<string | undefined> = [];
    const elicitations: unknown[] = [];
    const server = http.createServer(async (req, res) => {
      authorizations.push(req.headers.authorization);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const count = requests.length;
      const item =
        count % 2 === 1
          ? {
              type: "function_call",
              id: `fc_${count}`,
              call_id: `call_${count}`,
              namespace: "mcp__computer",
              name: "inspect_window",
              arguments: "{}",
              status: "completed",
            }
          : {
              type: "message",
              id: `msg_${count}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Inspected the window" }],
            };
      const events = [
        [
          "response.created",
          {
            response: {
              id: `resp_${count}`,
              status: "in_progress",
              output: [],
            },
          },
        ],
        [
          "response.output_item.added",
          { output_index: 0, item: { ...item, content: [] } },
        ],
        ["response.output_item.done", { output_index: 0, item }],
        [
          "response.completed",
          {
            response: {
              id: `resp_${count}`,
              status: "completed",
              output: [item],
              usage: {
                input_tokens: 2,
                output_tokens: 3,
                total_tokens: 5,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ],
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        events
          .map(
            ([type, data]) =>
              `event: ${type}\ndata: ${JSON.stringify({ type, ...(typeof data === "object" ? data : {}) })}\n\n`,
          )
          .join(""),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No fixture port");
    const client = new CodexAppServer(
      {
        apiKey: "fixture-api-key",
        env: {
          CODEX_HOME: home,
          HTTPS_PROXY: "http://127.0.0.1:9",
          HTTP_PROXY: "http://127.0.0.1:9",
          NO_PROXY: "127.0.0.1,localhost",
        },
        config: {
          model_provider: "fixture",
          model_providers: {
            fixture: {
              name: "Fixture",
              base_url: `http://127.0.0.1:${address.port}/v1`,
              wire_api: "responses",
              requires_openai_auth: true,
              supports_websockets: false,
            },
          },
          mcp_servers: {
            computer: {
              command: process.execPath,
              args: [
                path.join(import.meta.dirname, "fixtures/computer-use-mcp.mjs"),
              ],
            },
          },
          analytics: { enabled: false },
          feedback: { enabled: false },
        },
      },
      async (request) => {
        elicitations.push(request);
        if (action === "cancel") abort.abort();
        return { action: action === "cancel" ? "accept" : action, content: {} };
      },
    );
    try {
      const options = {
        workingDirectory: home,
        model: "gpt-5.3-codex",
        sandboxMode: "read-only",
        approvalPolicy: "on-request",
      } as const;
      let threadId = "";
      const results = [];
      const stream = await client
        .startThread(options)
        .runStreamed("Inspect the test window", { signal: abort.signal });
      for await (const event of stream.events) {
        results.push(event);
        if (event.type === "thread.started") threadId = event.thread_id;
      }
      expect(threadId).not.toBe("");
      expect(authorizations[0]).toBe("Bearer fixture-api-key");
      expect(elicitations).toEqual([
        expect.objectContaining({
          mode: "form",
          message: "Allow fixture window access?",
        }),
      ]);
      if (action === "cancel") {
        expect(results.at(-1)?.type).toBe("turn.failed");
        expect(JSON.stringify(requests)).not.toContain("input_image");
        return;
      }
      expect(JSON.stringify(requests[1])).toContain(
        action === "accept" ? "input_image" : "Window access declined",
      );
      expect(results.at(-1)?.type).toBe("turn.completed");
      const resumed = await client
        .resumeThread(threadId, options)
        .runStreamed("Inspect again", {});
      for await (const event of resumed.events) results.push(event);
      expect(elicitations).toHaveLength(2);
      expect(JSON.stringify(requests.at(-1))).toContain("call 2");
      expect(results.at(-1)?.type).toBe("turn.completed");
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
