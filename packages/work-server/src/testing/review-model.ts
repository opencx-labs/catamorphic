import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";
import {
  type ScriptedReply,
  type ScriptedRequest,
  startScriptedModel,
} from "@catamorphic/claude-code/testing";

/**
 * A model on loopback that drives a harness through a pull request review,
 * for end-to-end tests: each turn runs the change's tests with the
 * harness's shell tool, reads one file with its read tool, submits each
 * verified problem as a typed `finding` result and then its `review` with
 * Work's `submit_result` (ADR 0336), then ends. It speaks
 * the Anthropic Messages API, so it stands in for a provider wherever one
 * is reached (a server's own model, a model connection behind the
 * gateway), and it drives either harness Work runs a reviewer on: the
 * built-in agent (`bash`, `read`, `submit_result`) or Claude Code (`Bash`,
 * `Read`, `mcp__workspace__submit_result`). Each step follows from the
 * conversation it is sent (which tool results it already has), never from
 * how many calls came before, so side calls and retries change nothing;
 * each conversation is one chat, told apart by its first message.
 */
export interface ReviewModel {
  url: string;
  /** Every Messages API call, with its headers. */
  requests: ScriptedRequest[];
  /** The review turns of the chat whose first message includes `text`. */
  turnsOf(text: string): ReviewTurn[];
  close(): Promise<void>;
}

export interface ReviewTurn {
  /** What the tests printed (the shell tool's result). */
  commandOutput?: string;
  /** The file the read tool returned. */
  readOutput?: string;
  /** The findings it submitted, in order, with what each answer said. */
  findings?: Array<{ value: JsonObject; answer?: string }>;
  /** The review it submitted. */
  submitted?: JsonObject;
  /** What `submit_result` answered. */
  submitAnswer?: string;
}

/** Which chat and turn a step belongs to. */
export interface ReviewStep {
  /** The chat's first message. */
  prompt: string;
  /** 1 for the chat's first review turn. */
  turn: number;
}

export interface ReviewScript {
  /** The shell command each turn runs first: the change's tests. */
  command: string;
  /** A file each turn reads with the harness's read tool, in the checkout. */
  read: string;
  /**
   * The findings a turn submits after its read and before its review, in
   * order (a resubmission is an id again); none when absent.
   */
  findings?(input: ReviewStep & { commandOutput: string }): JsonObject[];
  /**
   * Called once `submit_result` answered a finding, before the turn's next
   * step: the turn is still at work, its harness waiting on this model.
   */
  onFinding?(
    input: ReviewStep & { index: number; finding: JsonObject; answer: string },
  ): Promise<void>;
  /** The review a turn submits, from what its command printed. */
  review(input: ReviewStep & { commandOutput: string }): JsonObject;
  /**
   * Called on each turn's first model call, before it is answered: the
   * harness is alive and waiting on it.
   */
  onTurnStart?(step: ReviewStep): Promise<void>;
}

const RUN = "toolu_run_";
const READ = "toolu_read_";
const SUBMIT = "toolu_submit_";
const FINDING = "toolu_finding_";

export async function startReviewModel(
  script: ReviewScript,
): Promise<ReviewModel> {
  const chats = new Map<string, ReviewTurn[]>();
  const started = new Set<string>();
  /** A finding's hook, once per finding: a retried request waits on it too. */
  const noticed = new Map<string, Promise<void>>();
  const reply = async (request: ScriptedRequest): Promise<ScriptedReply> => {
    const tools = toolNames(request.body);
    const claudeCode = tools.includes("Bash");
    // The harness's own calls (titles, summaries) carry no shell tool.
    if (!claudeCode && !tools.includes("bash"))
      return { blocks: [{ type: "text", text: "Pull request review" }] };
    const messages = list(request.body.messages);
    const prompt = textOf(record(messages[0]));
    const chat = chats.get(prompt) ?? [];
    chats.set(prompt, chat);
    // Only a user message starts a turn or answers a tool: Claude Code
    // also sends context as `system` messages, among them a reminder after
    // a while that the user has not heard from it.
    let last = messages.length - 1;
    while (last > 0 && record(messages[last]).role !== "user") last -= 1;
    // Each finished turn submitted once before the message answered now.
    const earlier = messages
      .slice(0, last)
      .flatMap((message) =>
        record(message).role === "user" ? toolResults(record(message)) : [],
      );
    const turn =
      earlier.filter((result) => result.id.startsWith(SUBMIT)).length + 1;
    const current: ReviewTurn = chat[turn - 1] ?? {};
    chat[turn - 1] = current;
    const answered = toolResults(record(messages[last])).at(-1);
    const step = { prompt, turn };
    if (!answered) {
      const key = `${prompt}\n${turn}`;
      if (!started.has(key)) {
        started.add(key);
        await script.onTurnStart?.(step);
      }
      return {
        blocks: [
          {
            type: "tool_use",
            id: `${RUN}${turn}`,
            name: claudeCode ? "Bash" : "bash",
            input: {
              command: script.command,
              description: "Run the change's tests",
            },
          },
        ],
      };
    }
    if (answered.id.startsWith(RUN)) {
      current.commandOutput = answered.text;
      return {
        blocks: [
          {
            type: "tool_use",
            id: `${READ}${turn}`,
            ...(claudeCode
              ? {
                  name: "Read",
                  input: {
                    file_path: `${workingDirectory(request.body)}/${script.read}`,
                  },
                }
              : { name: "read", input: { path: script.read } }),
          },
        ],
      };
    }
    const submit = tools.find(
      (name) => name === "submit_result" || name.endsWith("__submit_result"),
    );
    if (answered.id.startsWith(READ) || answered.id.startsWith(FINDING)) {
      if (!submit)
        return {
          blocks: [{ type: "text", text: "Work's submit_result is missing." }],
        };
      const input = { ...step, commandOutput: current.commandOutput ?? "" };
      const findings = script.findings?.(input) ?? [];
      let next = 0;
      if (answered.id.startsWith(READ)) current.readOutput = answered.text;
      else {
        const index = Number(answered.id.split("_").at(-1));
        const finding = findings[index] ?? {};
        current.findings ??= [];
        current.findings[index] = { value: finding, answer: answered.text };
        const key = `${prompt}\n${turn}\n${index}`;
        const hook =
          noticed.get(key) ??
          Promise.resolve(
            script.onFinding?.({
              ...step,
              index,
              finding,
              answer: answered.text,
            }),
          );
        noticed.set(key, hook);
        await hook;
        next = index + 1;
      }
      const finding = findings[next];
      if (finding) {
        current.findings ??= [];
        current.findings[next] ??= { value: finding };
        return {
          blocks: [
            {
              type: "tool_use",
              id: `${FINDING}${turn}_${next}`,
              name: submit,
              input: { name: "finding", value: finding },
            },
          ],
        };
      }
      const value = script.review(input);
      current.submitted = value;
      return {
        blocks: [
          {
            type: "tool_use",
            id: `${SUBMIT}${turn}`,
            name: submit,
            input: { name: "review", value },
          },
        ],
      };
    }
    if (answered.id.startsWith(SUBMIT)) current.submitAnswer = answered.text;
    return { blocks: [{ type: "text", text: "Submitted the review." }] };
  };
  const model = await startScriptedModel({ reply });
  return {
    url: model.url,
    requests: model.requests,
    turnsOf: (text) =>
      [...chats.entries()].find(([prompt]) => prompt.includes(text))?.[1] ?? [],
    close: () => model.close(),
  };
}

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function list(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function toolNames(body: JsonObject): string[] {
  return list(body.tools).flatMap((tool) => {
    const name = record(tool).name;
    return typeof name === "string" ? [name] : [];
  });
}

/** A message's text, whether a string or text blocks. */
function textOf(message: JsonObject): string {
  const content = message.content;
  return typeof content === "string"
    ? content
    : list(content)
        .map((part) => record(part).text)
        .filter((part) => typeof part === "string")
        .join("\n");
}

/** A user message's tool results, with their text. */
function toolResults(message: JsonObject): Array<{ id: string; text: string }> {
  return list(message.content).flatMap((block) => {
    const entry = record(block);
    if (entry.type !== "tool_result" || typeof entry.tool_use_id !== "string")
      return [];
    return [{ id: entry.tool_use_id, text: shellOutput(textOf(entry)) }];
  });
}

/**
 * The built-in agent's shell answers `{ exitCode, output }`, which reaches
 * the model as JSON: its output, as Claude Code's Bash gives it.
 */
function shellOutput(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed &&
      typeof parsed === "object" &&
      "output" in parsed &&
      typeof parsed.output === "string"
      ? parsed.output
      : text;
  } catch {
    return text;
  }
}

/** The checkout, as Claude Code's system prompt names it. */
function workingDirectory(body: JsonObject): string {
  const system =
    typeof body.system === "string"
      ? body.system
      : list(body.system)
          .map((part) => record(part).text)
          .filter((part) => typeof part === "string")
          .join("\n");
  return (
    /(?:Primary working directory|Working directory): (\/\S+)/
      .exec(system)?.[1]
      ?.replace(/\/$/, "") ?? "/workspace/project"
  );
}
