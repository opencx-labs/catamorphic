import { z } from "zod";

const person = z.object({
  login: z.string().optional(),
  name: z.string().optional(),
});
const comment = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  body: z.string().default(""),
  author: person.nullable().optional(),
  createdAt: z.string().optional(),
  submittedAt: z.string().nullable().optional(),
  url: z.string().optional(),
  state: z.string().optional(),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
  replyToId: z.number().optional(),
  diffHunk: z.string().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
});
export const prDetailsSchema = z.object({
  state: z.string(),
  reviewDecision: z.string().nullable().optional(),
  assignees: z.array(person).default([]),
  reviewRequests: z.array(person).default([]),
  reviews: z.array(comment).default([]),
  comments: z.array(comment).default([]),
  inlineComments: z.array(comment).default([]),
  inlineCommentsUnavailable: z.boolean().default(false),
  statusCheckRollup: z
    .array(
      z.object({
        name: z.string().optional(),
        context: z.string().optional(),
        status: z.string().optional(),
        state: z.string().optional(),
        conclusion: z.string().nullable().optional(),
        detailsUrl: z.string().optional(),
        targetUrl: z.string().optional(),
      }),
    )
    .nullable()
    .default([]),
});
export type PrDetails = z.infer<typeof prDetailsSchema>;

export const inlineCommentsSchema = z.array(
  z.array(
    z.object({
      id: z.number(),
      body: z.string(),
      user: person.nullable(),
      created_at: z.string(),
      html_url: z.string(),
      path: z.string(),
      line: z.number().nullable(),
      diff_hunk: z.string().optional(),
      side: z.enum(["LEFT", "RIGHT"]).optional(),
      original_line: z.number().nullable().optional(),
      in_reply_to_id: z.number().optional(),
    }),
  ),
);

export const prCommentInputSchema = z.object({
  projectId: z.string().min(1),
  number: z.number().int().positive(),
  body: z.string().trim().min(1).max(65536),
  replyTo: z.number().int().positive().optional(),
});
export type PrCommentInput = z.infer<typeof prCommentInputSchema>;
export type PrComment = PrDetails["comments"][number];
export const postedCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  user: person.nullable(),
  created_at: z.string(),
  html_url: z.string(),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
  in_reply_to_id: z.number().optional(),
  diff_hunk: z.string().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
});
