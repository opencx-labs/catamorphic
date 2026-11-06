import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../packages/agent-protocol/src/model.js";
import type {
  AttemptStart,
  HarnessAdapter,
  HarnessEvent,
  RunnerCommand,
  RunnerFrame,
} from "../../packages/agent-protocol/src/runner.js";
import { InProcessRunner } from "../../packages/agent-runner/src/index.js";

export interface AttemptEvidence {
  status: "completed" | "failed" | "interrupted" | "timeout";
  events: HarnessEvent[];
  errors: string[];
  elapsedMs: number;
}

/** The same runner/adapter protocol Work uses, with a bounded unattended host. */
export async function runAttempt(input: {
  adapter: HarnessAdapter;
  attempt: AttemptStart;
  timeoutMs: number;
  local?: Record<string, unknown>;
  frame: (frame: RunnerFrame) => void;
  tool?: (input: { name: string; input: JsonValue }) => Promise<JsonValue>;
}): Promise<AttemptEvidence> {
  const started = Date.now();
  const evidence: AttemptEvidence = {
    status: "failed",
    events: [],
    errors: [],
    elapsedMs: 0,
  };
  const nativeState = new Map<string, JsonValue[]>();
  const runner = new InProcessRunner({
    adapters: { [input.adapter.id]: input.adapter },
    version: "customization-eval",
    local: input.local,
  });
  const send = (command: RunnerCommand) =>
    runner.send({ id: randomUUID(), command });
  const deadline = started + input.timeoutMs;
  let seq = 0;
  try {
    send({ kind: "start", attempt: input.attempt });
    while (true) {
      if (Date.now() >= deadline) {
        evidence.status = "timeout";
        evidence.errors.push(`Agent exceeded ${input.timeoutMs}ms`);
        break;
      }
      const frames = await runner.read({
        afterSeq: seq,
        waitMs: Math.min(250, deadline - Date.now()),
      });
      for (const frame of frames) {
        seq = frame.seq;
        input.frame(frame);
        if (frame.type === "ack" && frame.error)
          evidence.errors.push(frame.error);
        if (frame.type === "exit" && frame.error)
          evidence.errors.push(frame.error.message);
        if (frame.type === "event") {
          const event = frame.event;
          evidence.events.push(event);
          if (event.type === "turn.completed") {
            evidence.status = event.status;
            if (event.error) evidence.errors.push(event.error.message);
          }
          if (event.type === "request.opened") {
            const response =
              event.request.kind === "approval"
                ? {
                    kind: "approval",
                    decision: "denied",
                    reason:
                      "This eval allows only the disposable project. Complete the task within its existing permissions.",
                  }
                : event.request.kind === "question"
                  ? {
                      kind: "question",
                      answers: (event.request.questions ?? [null]).map(
                        () =>
                          "Use your judgment to satisfy the request with the available primitives.",
                      ),
                    }
                  : { kind: "elicitation", action: "decline" };
            // All responses are validated at the runner boundary.
            if (response.kind === "approval")
              send({
                kind: "respond",
                requestKey: event.key,
                response: {
                  kind: "approval",
                  decision: "denied",
                  reason: response.reason,
                },
              });
            else if (response.kind === "question")
              send({
                kind: "respond",
                requestKey: event.key,
                response: { kind: "question", answers: response.answers ?? [] },
              });
            else
              send({
                kind: "respond",
                requestKey: event.key,
                response: { kind: "elicitation", action: "decline" },
              });
          }
        }
        if (frame.type === "call") {
          const call = frame.call;
          const key =
            call.kind === "tool"
              ? ""
              : `${call.thread ?? "own"}/${"subpath" in call ? (call.subpath ?? "") : ""}`;
          if (call.kind === "tool") {
            try {
              if (!input.tool)
                throw new Error(
                  `No host tool named ${call.name} is available in this eval.`,
                );
              send({
                kind: "host_result",
                callId: frame.callId,
                result: await input.tool(call),
              });
            } catch (error) {
              send({
                kind: "host_result",
                callId: frame.callId,
                error: {
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              });
            }
          } else if (call.kind === "native_state.append") {
            nativeState.set(key, [
              ...(nativeState.get(key) ?? []),
              ...call.entries,
            ]);
            send({ kind: "host_result", callId: frame.callId, result: null });
          } else if (call.kind === "native_state.load")
            send({
              kind: "host_result",
              callId: frame.callId,
              result: nativeState.get(key) ?? null,
            });
          else
            send({
              kind: "host_result",
              callId: frame.callId,
              result: [...nativeState.keys()]
                .filter((entry) => entry.startsWith(`${call.thread ?? "own"}/`))
                .map((entry) => entry.slice((call.thread ?? "own").length + 1)),
            });
        }
      }
      if (runner.exited) break;
    }
  } catch (error) {
    evidence.errors.push(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    try {
      await runner.kill();
    } catch (error) {
      evidence.errors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
    await input.adapter.dispose?.();
    evidence.elapsedMs = Date.now() - started;
  }
  return evidence;
}
