import {
  defineWorkflow,
  type TriggerConfig,
  type TriggerPayload,
  trigger,
} from "../src/index.js";

// Mirrors the generated catamorphic-triggers.d.ts a host projects into a
// project workspace.
declare module "../src/index.js" {
  interface TriggerKinds {
    "ticket.created": {
      payload: { ticketId: string; subject: string; priority: "low" | "high" };
      config: { onlyPriority?: "low" | "high" };
    };
    "ai.tool-call": {
      payload: { arguments: { [key: string]: string } };
      config: { description: string };
    };
  }
}

type TicketPayload = TriggerPayload<"ticket.created">;
type ToolConfig = TriggerConfig<"ai.tool-call">;

const ticketPayload: TicketPayload = {
  ticketId: "t1",
  subject: "hello",
  priority: "high",
};
void ticketPayload;

const toolConfig: ToolConfig = { description: "Search the knowledge base" };
void toolConfig;

defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ticket.created", { onlyPriority: "high" })],
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: {
        input: { ticketId: string; subject: string; priority: "low" | "high" };
      }) => ({ escalated: input.ticketId }),
    }),
  ],
}));

// Config is optional when every config field is optional.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ticket.created")],
  steps: [
    defineBoundary({
      run: async ({ input }: { input: TicketPayload }) => ({
        ok: input.subject,
      }),
    }),
  ],
}));

// @ts-expect-error Unknown trigger kinds are rejected.
const unknownKind = trigger("ticket.deleted", {});
void unknownKind;

// @ts-expect-error Config must match the kind's config type.
const wrongConfig = trigger("ai.tool-call", { description: 42 });
void wrongConfig;

// @ts-expect-error A kind with required config demands the config argument.
const missingRequiredConfig = trigger("ai.tool-call");
void missingRequiredConfig;

// @ts-expect-error The trigger payload must satisfy the first step's input.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ai.tool-call", { description: "search" })],
  steps: [
    defineBoundary({
      run: async ({ input }: { input: { somethingElse: number } }) => ({
        ok: input.somethingElse,
      }),
    }),
  ],
}));
