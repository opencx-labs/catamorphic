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
  "Ask the user one or more questions. Set blocking=false when independent work can continue while waiting. Answers are delivered automatically; do not poll or ask again. Use blocking=true when the answer is required before proceeding.";
export const agentQuestionJsonSchema = z.toJSONSchema(
  agentQuestionInputSchema,
  { io: "input" },
);
