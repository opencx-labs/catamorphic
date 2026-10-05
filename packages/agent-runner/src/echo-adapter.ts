import { randomUUID } from "node:crypto";
import type { JsonValue } from "@catamorphic/agent-protocol";
import {
  type AttemptControl,
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessCapabilities,
  RequestClosedError,
} from "@catamorphic/agent-protocol/runner";

const CAPABILITIES: HarnessCapabilities = {
  steer: true,
  interrupt: true,
  retry: true,
  fork: true,
  rollback: true,
  questions: true,
  approvals: true,
  elicitations: false,
  subagents: false,
  streamsText: true,
  streamsReasoning: false,
  nativeState: "store",
  ids: { thread: "strong", turn: "strong", item: "strong" },
};

/**
 * A deterministic harness for tests, e2e runs and fake-agent hosts. It
 * answers `Echo: <message>` and follows directives in the message:
 *
 * - `[[tool <name> <json>]]` calls a host tool
 * - `[[approve <server> <tool>]]` asks the tool policy
 * - `[[ask <question>]]` asks the person and echoes the answer
 * - `[[wait <ms>]]` works for a while (interruptible)
 * - `[[hang]]` works until interrupted
 * - `[[fail <message>]]` fails the turn
 * - `[[title <text>]]` sets the chat title
 * - `[[env <NAME>]]` says the variable as the attempt's environment has it
 * - `[[big <n>]]` says, and stores under subpath `big`, n three-byte characters
 *
 * Its native state is the list of turns it saw, stored with Work, so a
 * restored thread remembers ("turn 3") wherever it resumes.
 */
export class EchoAdapter implements HarnessAdapter {
  readonly id = "echo";

  capabilities(): HarnessCapabilities {
    return CAPABILITIES;
  }

  start(attempt: AttemptStart, host: AttemptHost): AttemptControl {
    let interrupted = false;
    let wake: (() => void) | undefined;
    const steered: string[] = [];
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    const run = async () => {
      const ref =
        attempt.thread.mode === "fresh"
          ? { id: randomUUID(), strength: "strong" as const }
          : attempt.thread.mode === "fork"
            ? { id: randomUUID(), strength: "strong" as const }
            : attempt.thread.nativeRef;
      host.emit({ type: "thread", ref });
      const seen =
        attempt.thread.mode === "fresh"
          ? []
          : attempt.thread.mode === "fork"
            ? await forkedFrom(host, attempt.thread)
            : ((await host.nativeState.load({})) ?? []);
      const turnNumber = seen.length + 1;
      host.emit({
        type: "turn.started",
        ref: { id: `${ref.id}:${turnNumber}`, strength: "strong" },
      });
      const text = attempt.input?.text ?? lastText(seen) ?? "";
      for (const directive of directives(text)) {
        if (interrupted) break;
        const [name, ...rest] = directive.split(" ");
        const argument = rest.join(" ");
        if (name === "tool") {
          const [tool = "tool", ...json] = rest;
          const key = `tool:${tool}:${randomUUID()}`;
          const input = parseJson(json.join(" "));
          host.emit({
            type: "item.started",
            key,
            item: {
              kind: "tool_call",
              tool,
              server: "workspace",
              description: null,
              input,
              result: null,
              error: null,
            },
          });
          try {
            const result = await host.callTool({
              name: tool,
              input,
              itemKey: key,
            });
            host.emit({
              type: "item.completed",
              key,
              status: result.isError ? "failed" : "completed",
              item: { result: JSON.parse(JSON.stringify(result)) as JsonValue },
            });
          } catch (error) {
            host.emit({
              type: "item.completed",
              key,
              status: "failed",
              item: {
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        } else if (name === "approve") {
          const [server = "server", tool = "tool"] = rest;
          const verdict = await host.authorize({ server, tool, input: {} });
          say(
            host,
            `approval:${randomUUID()}`,
            verdict.allowed ? `Allowed ${tool}.` : verdict.message,
          );
        } else if (name === "ask") {
          try {
            const response = await host.request(`ask:${randomUUID()}`, {
              kind: "question",
              blocking: true,
              title: "Question",
              origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
              questions: [
                {
                  question: argument || "Which one?",
                  header: "Question",
                  multiSelect: false,
                  options: [
                    { label: "Yes", description: "Go ahead" },
                    { label: "No", description: "Stop" },
                  ],
                },
              ],
            });
            say(
              host,
              `answer:${randomUUID()}`,
              response.kind === "question"
                ? `You answered: ${response.answers.join(", ")}`
                : "No answer.",
            );
          } catch (error) {
            if (!(error instanceof RequestClosedError)) throw error;
          }
        } else if (name === "wait") {
          host.emit({ type: "status", text: "Waiting" });
          await sleep(Number(argument) || 1_000);
        } else if (name === "hang") {
          host.emit({ type: "status", text: "Working" });
          while (!interrupted) await sleep(60_000);
        } else if (name === "fail") {
          host.emit({
            type: "turn.completed",
            status: "failed",
            error: { message: argument || "The echo harness failed." },
          });
          return;
        } else if (name === "env") {
          const value = attempt.env[argument];
          say(
            host,
            `env:${randomUUID()}`,
            value === undefined
              ? `${argument} is not set`
              : `${argument}=${value}`,
          );
        } else if (name === "title") {
          host.emit({ type: "title", text: argument });
        } else if (name === "big") {
          // Larger than one host read in UTF-8: the message is shortened,
          // the stored entry must arrive whole.
          const big = "界".repeat(Number(argument) || 400_000);
          say(host, `big:${randomUUID()}`, big);
          await host.nativeState.append({
            subpath: "big",
            entries: [{ big }],
          });
        }
      }
      if (interrupted) {
        host.emit({ type: "turn.completed", status: "interrupted" });
        return;
      }
      const reply = `Echo: ${stripDirectives(text)}${seen.length ? ` (turn ${turnNumber})` : ""}`;
      const key = `reply:${turnNumber}`;
      host.emit({
        type: "item.started",
        key,
        item: { kind: "assistant_message", text: "", agentId: null },
      });
      const half = Math.ceil(reply.length / 2);
      host.emit({
        type: "item.delta",
        key,
        field: "text",
        text: reply.slice(0, half),
      });
      host.emit({
        type: "item.delta",
        key,
        field: "text",
        text: reply.slice(half),
      });
      for (const steer of steered)
        host.emit({
          type: "item.delta",
          key,
          field: "text",
          text: `\nSteered: ${steer}`,
        });
      host.emit({ type: "item.completed", key, status: "completed" });
      await host.nativeState.append({
        entries: [{ turn: turnNumber, text }],
      });
      host.emit({
        type: "usage",
        usage: {
          inputTokens: text.length,
          outputTokens: reply.length,
          model: "echo",
        },
      });
      host.emit({
        type: "turn.completed",
        status: "completed",
        ref: { id: `${ref.id}:${turnNumber}`, strength: "strong" },
      });
    };
    const finished = run().catch((error: unknown) => {
      host.emit({
        type: "turn.completed",
        status: "failed",
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
    return {
      steer: async (input) => {
        steered.push(input.text);
        host.emit({ type: "input.consumed", itemIds: [input.itemId] });
        return true;
      },
      interrupt: () => {
        interrupted = true;
        wake?.();
      },
      finished,
    };
  }
}

function say(host: AttemptHost, key: string, text: string): void {
  host.emit({
    type: "item.started",
    key,
    status: "completed",
    item: { kind: "assistant_message", text, agentId: null },
  });
}

function directives(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) =>
    (match[1] ?? "").trim(),
  );
}

function stripDirectives(text: string): string {
  return text
    .replace(/\[\[[^\]]+\]\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lastText(seen: JsonValue[]): string | undefined {
  const last = seen.at(-1);
  return last &&
    typeof last === "object" &&
    !Array.isArray(last) &&
    typeof last.text === "string"
    ? last.text
    : undefined;
}

function parseJson(text: string): JsonValue {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

/**
 * A fork's history: the source thread's turns through the fork point, read
 * from the source and kept as this thread's own, as a native fork does.
 */
async function forkedFrom(
  host: AttemptHost,
  thread: Extract<AttemptStart["thread"], { mode: "fork" }>,
): Promise<JsonValue[]> {
  const source =
    (await host.nativeState.load({ thread: thread.source.id })) ?? [];
  const through = Number(thread.throughTurnRef?.id.split(":").at(-1));
  const kept = Number.isFinite(through) ? source.slice(0, through) : source;
  if (kept.length > 0) await host.nativeState.append({ entries: kept });
  return kept;
}
