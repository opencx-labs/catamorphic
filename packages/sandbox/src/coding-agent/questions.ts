import { z } from "zod";

/** One question batch, shared by every hosted harness. */
export const agentQuestionInputSchema = z.object({
  blocking: z
    .boolean()
    .default(true)
    .describe(
      "Wait for the answer when true. Set false to keep working; the answer arrives during the active turn when supported, or resumes the session later.",
    ),
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().min(1).max(12),
        multiSelect: z.boolean().default(false),
        options: z
          .array(z.object({ label: z.string(), description: z.string() }))
          .default([]),
      }),
    )
    .min(1)
    .max(4),
});
export const agentQuestionDescription =
  "Ask the user one or more questions. Ask only what you cannot find out yourself: look at their screen, files, and tabs with your tools before asking what they see. Set blocking=false when independent work can continue while waiting. Answers are delivered automatically; do not poll or ask again. Use blocking=true when the answer is required before proceeding. The user can always reply in their own words in the chat instead of picking an option, so do not add an 'Other' option.";
export const agentQuestionJsonSchema = z.toJSONSchema(
  agentQuestionInputSchema,
  { io: "input" },
);

/** Close questions this agent asked that are still open (ADR 0195). */
export const closeQuestionsInputSchema = z.object({
  requestIds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "The open question requests to close. Omit to close every question you asked in this chat that is still open.",
    ),
});
export const closeQuestionsDescription =
  "Close questions you asked that are still open in the chat, for example when the user answered them in a message or they no longer matter. Closed questions disappear from the chat and send no answer.";
export const closeQuestionsJsonSchema = z.toJSONSchema(
  closeQuestionsInputSchema,
  { io: "input" },
);

const QUESTION_REPLY = "QuestionReplyError";

/**
 * The person wrote in the chat while a blocking question waited, so the
 * asking call returns without an answer (ADR 0195). The message says what
 * happened to the question; the person's message itself arrives as input.
 */
export class QuestionReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = QUESTION_REPLY;
  }
}

/** By name, since harness bundles may hold their own copy of the class. */
export function isQuestionReply(error: unknown): error is QuestionReplyError {
  return error instanceof Error && error.name === QUESTION_REPLY;
}

/** An ask_user tool's text: the answer, or the note that the person replied. */
export async function askUserToolResult(
  answer: Promise<string>,
): Promise<string> {
  try {
    return await answer;
  } catch (error) {
    if (isQuestionReply(error)) return error.message;
    throw error;
  }
}
