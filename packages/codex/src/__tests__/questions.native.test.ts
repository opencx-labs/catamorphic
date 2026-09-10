import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexAppServer } from "../app-server.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "pinned Codex CLI answers blocking=%s questions in its active turn",
  async (blocking) => {
    const home = await mkdtemp(path.join(tmpdir(), "codex-questions-"));
    const asked = deferred();
    const continued = deferred();
    const answered = deferred();
    const requests: string[] = [];
    let pending = false;
    let acknowledged = 0;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(Buffer.concat(chunks).toString());
      const count = requests.length;
      // An in-flight second model call proves the non-blocking ask returned.
      if (!blocking && count === 2) {
        continued.resolve();
        await answered.promise;
      }
      const item =
        count === 1
          ? {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "ask_user",
              arguments: JSON.stringify({
                ...(blocking ? {} : { blocking }),
                questions: [
                  {
                    question: "Which theme?",
                    header: "Theme",
                    options: [],
                    multiSelect: false,
                  },
                ],
              }),
              status: "completed",
            }
          : {
              type: "message",
              id: `msg_${count}`,
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Independent work completed" },
              ],
            };
      const response = {
        id: `resp_${count}`,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
        },
      };
      const events = [
        {
          type: "response.created",
          response: { ...response, status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, content: [] },
        },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
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
    const client = new CodexAppServer({
      apiKey: "fixture-key",
      env: {
        CODEX_HOME: home,
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
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
        analytics: { enabled: false },
        feedback: { enabled: false },
      },
    });
    const abort = new AbortController();
    const events: string[] = [];
    const run = (async () => {
      const stream = await client
        .startThread({
          workingDirectory: home,
          model: "gpt-5.3-codex",
          sandboxMode: "read-only",
          approvalPolicy: "never",
        })
        .runStreamed("Ask my preference and continue independent work", {
          signal: abort.signal,
          turnOptions: {
            askQuestion: async (input) => {
              expect(input.blocking).toBe(blocking);
              asked.resolve();
              if (blocking) {
                await answered.promise;
                return "Choose orange";
              }
              return "Question saved. Continue independent work.";
            },
            readPendingMessages: async () =>
              pending ? [{ id: "answer-1", content: "Choose orange" }] : [],
            acknowledgeMessages: async ({ ids }) => {
              expect(ids).toEqual(["answer-1"]);
              acknowledged++;
              pending = false;
              answered.resolve();
            },
          },
        });
      for await (const event of stream.events) events.push(event.type);
    })();
    try {
      await Promise.race([
        asked.promise,
        run.then(() => {
          throw new Error(`No question: ${events}`);
        }),
      ]);
      if (blocking) {
        expect(requests).toHaveLength(1);
        answered.resolve();
      } else {
        await Promise.race([
          continued.promise,
          run.then(() => {
            throw new Error(`No independent work: ${events}`);
          }),
        ]);
        pending = true;
      }
      await run;
      expect(events.filter((type) => type === "turn.completed")).toHaveLength(
        1,
      );
      expect(events).not.toContain("turn.failed");
      expect(requests.at(-1)).toContain("Choose orange");
      expect(acknowledged).toBe(blocking ? 0 : 1);
    } finally {
      answered.resolve();
      abort.abort();
      client.close();
      await run.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
