import { randomUUID } from "node:crypto";
import type { JsonValue } from "@catamorphic/agent-protocol";
import {
  type AttemptHost,
  type HostToolResult,
  RequestClosedError,
  type RequestDraft,
} from "@catamorphic/agent-protocol/runner";
import { agentQuestionInputSchema } from "@catamorphic/sandbox";

const text = (value: string, isError = false): HostToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError } : {}),
});

/**
 * Work's `ask_user` tool, answered in the runner for every harness (ADR
 * 0195): a blocking ask waits for the person's answer; a non-blocking one
 * opens the question and returns, and its answer arrives as a message.
 */
export async function askUser(
  host: Pick<AttemptHost, "request">,
  call: { input: JsonValue; itemKey?: string },
): Promise<HostToolResult> {
  const parsed = agentQuestionInputSchema.safeParse(call.input);
  if (!parsed.success)
    return text(`These questions are not valid: ${parsed.error.message}`, true);
  const { questions, blocking } = parsed.data;
  const first = questions[0];
  const draft: RequestDraft = {
    kind: "question",
    blocking,
    title:
      questions.length === 1 && first
        ? first.question
        : `${questions.length} questions`,
    origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
    questions,
  };
  const key = `ask:${call.itemKey ?? randomUUID()}`;
  if (!blocking) {
    host.request(key, draft).catch(() => {});
    return text(
      "Asked. The answer arrives as a message when the person replies; keep working on what does not depend on it.",
    );
  }
  try {
    const response = await host.request(key, draft);
    if (response.kind !== "question") return text("The person did not answer.");
    return text(
      questions
        .map(
          (question, index) =>
            `${question.question}\nAnswer: ${response.answers[index] ?? "(no answer)"}`,
        )
        .concat(response.answers.slice(questions.length))
        .join("\n\n"),
    );
  } catch (cause) {
    if (cause instanceof RequestClosedError)
      return text(`The question was closed without an answer: ${cause.reason}`);
    throw cause;
  }
}
