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
  "Ask the user for missing information, preferences, or decisions. Use this tool instead of asking in chat text or using native question tools, including for required and open-ended questions. Ask only what you cannot find out yourself: inspect the screen, files, and tabs first, and use sensible defaults for routine implementation choices. Set blocking=false when independent work can continue while waiting; use blocking=true when the answer is required before proceeding. Answers arrive automatically; do not poll or ask again. For open-ended questions use options: []; otherwise give concise choices with descriptions, putting the recommended choice first and marking it '(Recommended)'. The user can always answer in their own words, so do not add an 'Other' option. Do not ask for permission to perform work already authorized.";
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
