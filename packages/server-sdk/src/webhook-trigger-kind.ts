import { webhookConfig } from "@catamorphic/core";
import { z } from "zod";
import { defineTriggerKind } from "./define-trigger-kind.js";

/**
 * An HTTP request delivered to the project's webhook URL (ADRs 0156,
 * 0171). Brain servers receive it, check it as the binding declares
 * (`verify`: an HMAC over a signed-content template or a shared token),
 * answer declared handshakes (`respond`) synchronously, and store any other
 * request durably, answer 202 and run every workflow bound to the name
 * whose `where` matches, with the stored request as input. Integrations are
 * configurations of this one kind, usually declared once in a project
 * trigger kind in `.work/triggers/`.
 */
export const webhook = defineTriggerKind({
  name: "webhook",
  description:
    "Starts a workflow when an outside service sends a request to one of the project's webhook URLs.",
  display: { label: "Webhook", icon: "webhook" },
  modes: ["async"],
  config: webhookConfig,
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
      query: z.record(z.string(), z.string()),
      contentType: z.string().nullable(),
      body: z.json(),
      /**
       * True when the host fetched the event itself from the sender's API
       * with its own connection instead of receiving a signed request (the
       * desktop's GitHub poller, ADR 0177): there is no signature to check.
       */
      hostVerified: z.boolean().optional(),
    }),
  }),
  matches: ({ config, payload }) => payload.payload.name === config.name,
  correlationKey: (event) => event.id,
});
