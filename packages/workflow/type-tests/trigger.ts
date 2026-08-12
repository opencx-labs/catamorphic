import type { Hole } from "../src/holes.js";
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
    // A fully parameterized kind: the whole payload is one hole, filled by
    // each bound workflow's own input type.
    "ai.tool-call": {
      payload: Hole<"Args">;
      config: { description: string };
    };
    // An array-carrying payload, for the tuple-soundness cases below.
    "ticket.batch": {
      payload: { items: { id: string }[] };
      config: Record<string, never>;
    };
    // A kind with a fixed envelope around a hole, plus an output template
    // whose body is itself a hole.
    "http.request": {
      payload: {
        method: string;
        headers: { [key: string]: string };
        body: Hole<"Body">;
      };
      config: { path: string };
      output: { status: number; body: Hole<"Response"> };
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

// A whole-payload hole matches ANY input: the workflow's own input type is
// the instantiation, and the derived schema becomes the tool's schema.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ai.tool-call", { description: "look up the weather" })],
  steps: [
    defineBoundary({
      run: async ({ input }: { input: { city: string; units?: string } }) => ({
        temperature: input.city.length,
      }),
    }),
  ],
}));

// An envelope kind: fixed parts must be accepted by the input; the hole is
// filled by whatever the input declares at that position. The output must
// provide the template's fixed fields; its hole is the workflow's to shape.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("http.request", { path: "/orders" })],
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: {
        input: {
          method: string;
          headers: { [key: string]: string };
          body: { orderId: string };
        };
      }) => ({ status: 200, body: { received: input.body.orderId } }),
    }),
  ],
}));

// Plain-array inputs match element-wise, holes included.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ai.tool-call", { description: "batch lookup" })],
  steps: [
    defineBoundary({
      run: async ({ input }: { input: { cities: string[] } }) => ({
        count: input.cities.length,
      }),
    }),
  ],
}));

// Plain-array template fields match structurally compatible array inputs.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ticket.batch")],
  steps: [
    defineBoundary({
      run: async ({ input }: { input: { items: { id: string }[] } }) => ({
        count: input.items.length,
      }),
    }),
  ],
}));

// @ts-expect-error A tuple input demands exact assignability: the host
// fires plain arrays, so a fixed arity can never be guaranteed.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ticket.batch")],
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: {
        input: { items: [{ id: string }, { id: string }] };
      }) => ({ first: input.items[0].id }),
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
  triggers: [trigger("ticket.created")],
  steps: [
    defineBoundary({
      run: async ({ input }: { input: { somethingElse: number } }) => ({
        ok: input.somethingElse,
      }),
    }),
  ],
}));

// @ts-expect-error A fixed envelope field the input types differently fails.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("http.request", { path: "/orders" })],
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: {
        input: {
          method: number;
          headers: { [key: string]: string };
          body: { note: string };
        };
      }) => ({ status: 200, body: { method: input.method } }),
    }),
  ],
}));

// @ts-expect-error A required input field outside the template fails: the
// host can never fill it.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("http.request", { path: "/orders" })],
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: {
        input: {
          method: string;
          headers: { [key: string]: string };
          body: { note: string };
          mustHave: string;
        };
      }) => ({ status: 200, body: { got: input.mustHave } }),
    }),
  ],
}));

// @ts-expect-error The output template's fixed fields must be produced.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("http.request", { path: "/orders" })],
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: {
        input: {
          method: string;
          headers: { [key: string]: string };
          body: { note: string };
        };
      }) => ({ body: { ok: input.method } }),
    }),
  ],
}));
