import {
  type BoundaryContext,
  defineTrigger,
  defineWorkflow,
  type Narrow,
  type PayloadOf,
  type TriggerPayload,
  trigger,
  type Where,
} from "../src/index.js";

// Mirrors the generated work-triggers.d.ts: the host's webhook kind, and
// the project's own kinds typed from their trigger modules (ADR 0171).
declare module "../src/index.js" {
  interface TriggerKinds {
    webhook: {
      payload: {
        id: string;
        kind: "webhook";
        payload: {
          name: string;
          headers: { [key: string]: string };
          contentType: string | null;
          body:
            | null
            | boolean
            | number
            | string
            | { [key: string]: unknown }
            | unknown[];
        };
      };
      config: {
        name: string;
        verify?: { scheme: "hmac"; secret: string; header: string };
      };
    };
    "github.pull_request": {
      payload: PayloadOf<typeof pullRequest>;
      config: Record<string, never>;
    };
    "github.merged": {
      payload: PayloadOf<typeof merged>;
      config: Record<string, never>;
    };
    "gh.any": {
      payload: PayloadOf<typeof anyDelivery>;
      config: Record<string, never>;
    };
  }
}

interface PullRequestBody {
  action: "opened" | "synchronize" | "closed";
  number: number;
  pull_request: { merged: boolean; title: string };
}

type PullRequestDelivery = Narrow<
  TriggerPayload<"webhook">,
  { payload: { body: PullRequestBody } }
>;

// @ts-expect-error Narrowing keeps the envelope and types the body.
const notABody: PullRequestDelivery["payload"]["body"] = "text";
void notABody;
const envelopeName: string = ({} as PullRequestDelivery).payload.name;
void envelopeName;

const untyped = defineTrigger({
  name: "gh.untyped",
  from: trigger("webhook", { name: "github" }),
  // @ts-expect-error Without a type argument, `where` follows `from`'s payload.
  where: { payload: { hedrs: { "x-github-event": "push" } } },
});
void untyped;

// An explicit payload type narrows what the underlying kind delivers; the
// kind's `where` is typed against it.
const pullRequest = defineTrigger<PullRequestDelivery>({
  name: "github.pull_request",
  description: "A pull request changed",
  from: trigger("webhook", {
    name: "github",
    verify: { scheme: "hmac", secret: "GITHUB_SECRET", header: "x-sig" },
  }),
  where: { payload: { headers: { "x-github-event": "pull_request" } } },
});

// Without a type argument the kind delivers what `from` delivers, and a
// project kind may build on another project kind.
const merged = defineTrigger({
  name: "github.merged",
  from: trigger("github.pull_request", {
    where: { payload: { body: { action: "closed" } } },
  }),
  where: { payload: { body: { pull_request: { merged: true } } } },
});

const anyDelivery = defineTrigger({
  name: "gh.any",
  from: trigger("webhook", { name: "github" }),
});

const mergedPayload: PayloadOf<typeof merged> = {} as PullRequestDelivery;
void mergedPayload;
const anyPayload: TriggerPayload<"webhook"> = {} as PayloadOf<
  typeof anyDelivery
>;
void anyPayload;

// Workflows bind project kinds by name and add their own `where`: one
// value, a list of values, or `{ $exists }`.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("github.pull_request", {
      where: {
        payload: {
          body: {
            action: ["opened", "synchronize"],
            pull_request: { title: { $exists: true } },
          },
        },
      },
    }),
    trigger("github.merged"),
  ],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<PullRequestDelivery>) => ({
        number: input.payload.body.number,
      }),
    }),
  ],
}));

// Host kinds accept `where` beside their own config.
const filteredWebhook = trigger("webhook", {
  name: "github",
  where: { payload: { contentType: ["application/json", null] } },
});
void filteredWebhook;

const wrongValue = trigger("github.pull_request", {
  // @ts-expect-error A where leaf must hold a value of the payload's type.
  where: { payload: { body: { action: "reopened" } } },
});
void wrongValue;

// A string position also takes `{ $prefix }`; a number position does not.
const titled = trigger("github.pull_request", {
  where: {
    payload: { body: { pull_request: { title: { $prefix: "[db]" } } } },
  },
});
void titled;

const numberPrefix = trigger("github.pull_request", {
  // @ts-expect-error Only strings have prefixes.
  where: { payload: { body: { number: { $prefix: "4" } } } },
});
void numberPrefix;

// Keys starting with `$` are operators, so a payload field named `exists`
// or `prefix` is an ordinary position compared by value.
type Flagged = { flag: { exists: boolean }; ref: { prefix: string } };
const flaggedWhere: Where<Flagged> = {
  flag: { exists: true },
  ref: { prefix: "v1" },
};
void flaggedWhere;
const flaggedOperator: Where<Flagged> = { ref: { prefix: { $prefix: "v" } } };
void flaggedOperator;
// @ts-expect-error The field `exists` holds a boolean, compared by value.
const flaggedWrong: Where<Flagged> = { flag: { exists: "yes" } };
void flaggedWrong;

const wrongKey = trigger("github.pull_request", {
  // @ts-expect-error A where names only positions the payload has.
  where: { payload: { bdy: { action: "opened" } } },
});
void wrongKey;

const unknownProjectKind = defineTrigger({
  name: "gh.nope",
  // @ts-expect-error A project kind builds on a kind that exists.
  from: trigger("gh.unknown"),
});
void unknownProjectKind;

// @ts-expect-error The payload must satisfy the first step's input.
defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("github.pull_request")],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ ticketId: string }>) => ({
        ok: input.ticketId,
      }),
    }),
  ],
}));
