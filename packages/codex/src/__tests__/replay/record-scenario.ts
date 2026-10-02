import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { createCodexAdapter } from "../../adapter.js";
import type { CodexTranscript } from "../../testing/index.js";
import { CodexRecorder } from "../../testing/record.js";
import { type AttemptResult, driveAttempt, NativeStore } from "./driver.js";
import {
  type ModelItem,
  type ModelResponse,
  type Scenario,
  WORKSPACE_FILES,
} from "./scenarios.js";

/** This package's MCP fixtures, for scenarios that run one. */
export const MCP_FIXTURES = path.resolve(import.meta.dirname, "../fixtures");

/**
 * Run a scenario against the real Codex CLI and a scripted loopback
 * Responses API, recording what crossed the app-server process. Throws if
 * Codex did not send the model what the scenario expects (a restored
 * thread must remember, a fork must not).
 */
export async function recordScenario(input: {
  scenario: Scenario;
  command: string;
  cliVersion: string;
}): Promise<{ transcript: CodexTranscript; results: AttemptResult[] }> {
  const { scenario } = input;
  const root = await mkdtemp(
    path.join(await realpath(tmpdir()), "codex-replay-"),
  );
  const problems: string[] = [];
  const model = await modelServer(scenario.model, problems);
  try {
    await mkdir(path.join(root, "work"), { recursive: true });
    for (const [file, text] of Object.entries(WORKSPACE_FILES))
      await writeFile(path.join(root, "work", file), text);
    await writeFile(path.join(root, "model-key"), "fixture-model-key");
    const context = {
      root,
      model: model.url,
      node: process.execPath,
      fixtures: MCP_FIXTURES,
      command: input.command,
    };
    const recorder = new CodexRecorder();
    const adapter = createCodexAdapter({ transport: recorder.transport });
    const store = new NativeStore();
    const results: AttemptResult[] = [];
    for (const attempt of scenario.attempts)
      results.push(
        await driveAttempt({
          adapter,
          attempt: attempt.build(context, results),
          store,
          ...(attempt.script ? { script: attempt.script } : {}),
        }),
      );
    if (model.served() < scenario.model.length)
      problems.push(
        `Codex asked the model ${model.served()} times; the script has ${scenario.model.length} responses`,
      );
    if (problems.length > 0)
      throw new Error(`${scenario.name}: ${problems.join("; ")}`);
    const transcript = await recorder.transcript({
      scenario: scenario.name,
      description: scenario.description,
      cliVersion: input.cliVersion,
      placeholders: {
        root,
        model: model.url,
        node: process.execPath,
        fixtures: MCP_FIXTURES,
        host: hostname(),
        tmp: await realpath(tmpdir()),
      },
    });
    return { transcript, results };
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
}

/** A loopback Responses API that serves a scenario's responses in order. */
async function modelServer(
  responses: ModelResponse[],
  problems: string[],
): Promise<{
  url: string;
  served: () => number;
  close: () => Promise<void>;
}> {
  let count = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.method !== "POST") {
      // Codex refreshes its model catalog; an empty one is fine.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    count += 1;
    const plan = responses[count - 1];
    const body = Buffer.concat(chunks).toString();
    const mentions = (text: string) =>
      body.includes(JSON.stringify(text).slice(1, -1));
    if (plan && "items" in plan) {
      for (const text of plan.expectInput ?? [])
        if (!mentions(text))
          problems.push(
            `model request ${count} does not mention ${JSON.stringify(text)}`,
          );
      for (const text of plan.rejectInput ?? [])
        if (mentions(text))
          problems.push(
            `model request ${count} mentions ${JSON.stringify(text)}`,
          );
    }
    if (!plan) {
      problems.push(`model request ${count} has no scripted response`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "No scripted response" } }));
      return;
    }
    if ("status" in plan) {
      res.writeHead(plan.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: plan.error }));
      return;
    }
    await stream(res, count, plan);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The model server has no port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    served: () => count,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type SseEvent = Record<string, unknown> & { type: string };

/** One Responses API stream: a pause or hang starts after the first text delta. */
async function stream(
  res: http.ServerResponse,
  request: number,
  plan: Extract<ModelResponse, { items: ModelItem[] }>,
): Promise<void> {
  const id = `resp_${request}`;
  const usage = {
    input_tokens: 120 * request,
    output_tokens: 30,
    total_tokens: 120 * request + 30,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens_details: { reasoning_tokens: 8 },
  };
  const before: SseEvent[] = [
    {
      type: "response.created",
      response: { id, status: "in_progress", output: [] },
    },
  ];
  const after: SseEvent[] = [];
  const holds = Boolean(plan.pauseMs || plan.hang);
  let held = false;
  const output: Record<string, unknown>[] = [];
  plan.items.forEach((item, index) => {
    const events = held ? after : before;
    if ("message" in item) {
      const itemId = `msg_${request}_${index}`;
      const done = {
        type: "message",
        id: itemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: item.message, annotations: [] }],
      };
      output.push(done);
      const half = Math.ceil(item.message.length / 2);
      const delta = (text: string): SseEvent => ({
        type: "response.output_text.delta",
        output_index: index,
        content_index: 0,
        item_id: itemId,
        delta: text,
      });
      events.push(
        {
          type: "response.output_item.added",
          output_index: index,
          item: { ...done, status: "in_progress", content: [] },
        },
        delta(item.message.slice(0, half)),
      );
      if (holds) held = true;
      (held ? after : events).push(delta(item.message.slice(half)), {
        type: "response.output_item.done",
        output_index: index,
        item: done,
      });
      return;
    }
    if ("reasoning" in item) {
      const itemId = `rs_${request}_${index}`;
      const done = {
        type: "reasoning",
        id: itemId,
        summary: item.reasoning.map((text) => ({ type: "summary_text", text })),
      };
      output.push(done);
      events.push({
        type: "response.output_item.added",
        output_index: index,
        item: { ...done, summary: [] },
      });
      item.reasoning.forEach((text, summaryIndex) => {
        const part = {
          item_id: itemId,
          output_index: index,
          summary_index: summaryIndex,
        };
        events.push(
          {
            type: "response.reasoning_summary_part.added",
            ...part,
            part: { type: "summary_text", text: "" },
          },
          {
            type: "response.reasoning_summary_text.delta",
            ...part,
            delta: text,
          },
          { type: "response.reasoning_summary_text.done", ...part, text },
          {
            type: "response.reasoning_summary_part.done",
            ...part,
            part: { type: "summary_text", text },
          },
        );
      });
      events.push({
        type: "response.output_item.done",
        output_index: index,
        item: done,
      });
      return;
    }
    const done = {
      type: "function_call",
      id: `fc_${request}_${index}`,
      call_id: `call_${request}_${index}`,
      name: item.call,
      arguments: JSON.stringify(item.args),
      status: "completed",
      ...(item.namespace ? { namespace: item.namespace } : {}),
    };
    output.push(done);
    events.push(
      { type: "response.output_item.added", output_index: index, item: done },
      { type: "response.output_item.done", output_index: index, item: done },
    );
  });
  (held ? after : before).push({
    type: "response.completed",
    response: { id, status: "completed", output, usage },
  });
  const sse = (events: SseEvent[]) =>
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(sse(before));
  if (plan.hang) {
    await new Promise<void>((resolve) => res.once("close", () => resolve()));
    return;
  }
  if (plan.pauseMs)
    await new Promise((resolve) => setTimeout(resolve, plan.pauseMs));
  res.end(sse(after));
}
