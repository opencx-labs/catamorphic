import { Cron } from "croner";
import { z } from "zod";
import { defineTriggerKind } from "./define-trigger-kind.js";

const recurringSchedule = z
  .strictObject({
    cron: z.string().min(1),
    timezone: z.string().min(1),
  })
  .superRefine((value, context) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format();
      new Cron(value.cron, { timezone: value.timezone, paused: true });
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid schedule",
      });
    }
  });

/** Built-in clock source. Schedule is an ordinary asynchronous trigger. */
export const schedule = defineTriggerKind({
  name: "schedule",
  description:
    "Starts a workflow once at an absolute timestamp, or on a cron schedule in an IANA timezone.",
  display: { label: "Schedule", icon: "clock" },
  modes: ["async"],
  config: z.union([
    z.strictObject({ at: z.string().datetime({ offset: true }) }),
    recurringSchedule,
  ]),
  payload: z.strictObject({
    activationId: z.string().uuid(),
    scheduledFor: z.string().datetime(),
    firedAt: z.string().datetime(),
  }),
  correlationKey: (payload) =>
    `${payload.activationId}:${payload.scheduledFor}`,
});
