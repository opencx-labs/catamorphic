import { z } from "zod";
import { defineTriggerKind } from "./define-trigger-kind.js";

/** A webhook's name: its URL segment and what workflows subscribe to. */
export const WEBHOOK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Optional HMAC check for senders that sign their deliveries (GitHub,
 * Shopify, Standard Webhooks and most others): the header carrying the
 * signature, an optional prefix before it ("sha256="), its encoding, and
 * the project secret holding the signing key. Every workflow bound to one
 * webhook name must declare the same check.
 */
export const webhookVerifyConfig = z.strictObject({
  secret: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, "Use the project secret's name"),
  header: z.string().min(1).max(100),
  prefix: z.string().max(40).optional(),
  encoding: z.enum(["hex", "base64"]).optional(),
});

export type WebhookVerifyConfig = z.output<typeof webhookVerifyConfig>;

/**
 * An HTTP request delivered to the project's webhook URL (ADR 0156). Brain
 * servers receive it, store it durably, answer 202 and then run every
 * workflow bound to the name, with the stored request as input.
 */
export const webhook = defineTriggerKind({
  name: "webhook",
  description:
    "Starts a workflow when an outside service sends a request to one of the project's webhook URLs.",
  display: { label: "Webhook", icon: "webhook" },
  modes: ["async"],
  config: z.strictObject({
    name: z
      .string()
      .regex(WEBHOOK_NAME_PATTERN, "Use lowercase letters, digits and dashes"),
    verify: webhookVerifyConfig.optional(),
  }),
  payload: z.object({
    id: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    projectId: z.string().uuid(),
    source: z.literal("webhook"),
    kind: z.literal("webhook"),
    externalId: z.string(),
    occurredAt: z.string().datetime(),
    receivedAt: z.string().datetime(),
    payload: z.object({
      name: z.string(),
      headers: z.record(z.string(), z.string()),
      contentType: z.string().nullable(),
      body: z.json(),
    }),
  }),
  matches: ({ config, payload }) => payload.payload.name === config.name,
  correlationKey: (event) => event.id,
});
