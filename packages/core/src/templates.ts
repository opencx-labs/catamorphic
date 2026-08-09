import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  defaultWorkflow: string;
  files: Record<string, string>;
}

const SHARED_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "noEmit": true
  },
  "include": ["src"]
}`;

const pkg = ({
  name,
  dependencies,
}: {
  name: string;
  dependencies?: Record<string, string>;
}) =>
  JSON.stringify(
    {
      name,
      version: "1.0.0",
      private: true,
      type: "module",
      ...(dependencies ? { dependencies } : {}),
    },
    null,
    2,
  );

const CONTRACTS_INDEX = `/**
 * Shared types between workflows and apps. This package must never contain
 * runtime code: apps bundle what they import, and a types-only package has no
 * JavaScript to pull into the browser.
 */
export {};
`;

/**
 * Workspace scaffolding shared by every template. A project is a bun workspace
 * so one repo holds backend workflows and frontend apps, with `contracts` as
 * the only package both sides depend on.
 */
const workspaceFiles = ({
  name,
  dependencies,
}: {
  name: string;
  dependencies?: Record<string, string>;
}): Record<string, string> => ({
  "package.json": JSON.stringify(
    {
      name,
      version: "1.0.0",
      private: true,
      workspaces: ["contracts", "workflows", "apps/*"],
    },
    null,
    2,
  ),
  "contracts/package.json": JSON.stringify(
    {
      name: "@project/contracts",
      version: "1.0.0",
      private: true,
      type: "module",
      types: "./src/index.ts",
      exports: { ".": { types: "./src/index.ts" } },
    },
    null,
    2,
  ),
  "contracts/tsconfig.json": SHARED_TSCONFIG,
  "contracts/src/index.ts": CONTRACTS_INDEX,
  "workflows/package.json": pkg({
    name: "@project/workflows",
    dependencies: {
      "@project/contracts": "workspace:*",
      ...dependencies,
    },
  }),
  "workflows/tsconfig.json": SHARED_TSCONFIG,
});

/**
 * Scaffold for one app under `apps/<name>/`. Vite builds in IIFE lib mode to
 * exactly one `dist/app.js` + one `dist/app.css`; everything imported (react
 * included) is bundled in, which is what lets the host render the bundle in a
 * credential-less sandboxed iframe.
 */
export const appScaffold = ({
  name,
}: {
  name: string;
}): Record<string, string> => ({
  [`apps/${name}/package.json`]: JSON.stringify(
    {
      name,
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { build: "vite build", dev: "vite" },
      dependencies: {
        "@catamorphic/app": APP_PACKAGE_VERSION,
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
      devDependencies: {
        "@project/contracts": "workspace:*",
        "@types/react": "^19.0.0",
        "@types/react-dom": "^19.0.0",
        "@vitejs/plugin-react": "^4.3.0",
        typescript: "^5.7.0",
        vite: "^6.0.0",
      },
    },
    null,
    2,
  ),
  [`apps/${name}/tsconfig.json`]: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "noEmit": true
  },
  "include": ["src"]
}`,
  [`apps/${name}/vite.config.ts`]: `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// One self-executing JS file + one CSS file: the { code, css } pair the host
// mounts in a sandboxed iframe. Lib mode with an iife output guarantees a
// single chunk; everything imported (react included) is bundled in.
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  // Force a single React instance: a CJS dependency consuming React can be
  // double-instantiated across the CJS/ESM boundary, leaving hooks with a
  // null dispatcher.
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    lib: {
      entry: "src/main.tsx",
      formats: ["iife"],
      name: "app",
      fileName: () => "app.js",
      cssFileName: "app",
    },
    outDir: "dist",
  },
});
`,
  [`apps/${name}/src/main.tsx`]: `import { createRoot } from "react-dom/client";
import { App } from "./app.js";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
`,
});

export const APP_PACKAGE_VERSION = "0.0.1";

export const BATCH_WORKFLOW_SKILL_PATH =
  ".agents/skills/batch-workflows/SKILL.md";
export const DURABLE_WORKFLOW_SKILL_PATH =
  ".agents/skills/durable-workflows/SKILL.md";

/**
 * Per-project agent skills seeded into every project (templates and blank
 * ones alike). Skills live in the project repo under
 * `.agents/skills/<name>/SKILL.md` (Agent Skills spec) so they are versioned
 * with the code, scoped per project, and read by coding agents from the dev
 * sandbox checkout.
 */
export const SEED_SKILLS: Record<string, string> = {
  ".agents/skills/writing-workflows/SKILL.md": `---
name: writing-workflows
description: Writes and edits Catamorphic Workflows using plain functions or persisted boundary and batch scopes. Use when creating workflows, adding steps, changing workflow logic, or choosing capabilities.
---

# Writing Workflows

## Choose the workflow capabilities

Inspect the existing export before editing it and preserve its authoring model
unless the user explicitly requests a conversion.

- **Plain workflow function:** an exported async function containing
  \`"use workflow"\`. Use for one request, event, entity, or orchestration run.
- **Defined workflow:** an exported \`defineWorkflow(...)\` whose ordered steps
  use builder-scoped \`defineBoundary\` and \`defineBatch\`. Use boundaries for
  explicit retries, pauses, or child workflows. Use batches for persisted paged
  collections, bounded concurrency, physical batching, progress, or resumable
  output.

Do not add \`"use workflow"\` to a \`defineWorkflow\` definition. Do not add a
batch scope merely to process an array supplied in one request.

## Shared rules

1. Every workflow and step takes one destructured object parameter.
2. Every UI-facing workflow, step, and parameter has JSDoc metadata with
   \`@displayname\`; steps may also use \`@icon\`.
3. Keep orchestration code simple: awaited calls, \`if\`/\`else\`, loops, and
   \`Promise.all\`. The visual graph is derived from this structure.
4. Put IO and business operations in steps. Keep workflow bodies declarative.

## Plain workflow functions

\`\`\`typescript
/**
 * @displayname Greet User
 * @description Send a greeting to a user
 */
export async function greetUser({ email }: { email: string }) {
  "use workflow";
  await sendGreeting({ to: email });
  return { status: "sent" };
}

/**
 * @displayname Send Greeting
 * @icon mail
 * @param to - @displayname Recipient | @description Email address to send to
 */
async function sendGreeting({ to }: { to: string }) {
  "use step";
}
\`\`\`

## Paged batch scopes

Read [the batch scope skill](../batch-workflows/SKILL.md) before creating or
substantially editing a \`defineBatch\` scope.

Key rules:

- The source emits stable, unique item keys and uses a persisted cursor.
- \`process\` describes one logical item. Regular \`"use step"\` calls still
  execute per item.
- Use an exported \`defineBatchStep\` only when an operation benefits from
  physically coalescing multiple items. Return exactly one keyed outcome for
  every input key.
- Batch-step failures declare whether they are retryable. Never depend on input
  order when matching outcomes.
- Sinks must tolerate retries, acknowledge keys, and finalize from persisted
  state.
- Use \`skipBatchItem({ reason })\` for intentionally ignored items.
- Preserve source keys, replay behavior, and existing batch policies when
  editing.

## Boundary and pause scopes

Read [the boundary scope skill](../durable-workflows/SKILL.md) before creating
or substantially editing boundaries, pauses, or child calls. Defined Workflows
execute in production with persisted continuation state.

## App-callable workflows

Read [the building-apps skill](../building-apps/SKILL.md) before exposing a
workflow to apps or editing \`workflows/src/app-api.ts\`. Key rules:

- A workflow is app-callable only when exported from \`app-api.ts\`; keep
  that surface minimal and deliberate.
- Prefer plain \`"use workflow"\` functions for app-facing reads — they
  resolve inline. Persisted definitions surface to apps as pollable handles.
- Inputs and outputs must survive JSON: no dates, maps, sets, functions, or
  \`undefined\`. Send ISO strings and plain objects.
- App-callable workflows receive untrusted input from a viewer's browser.
  Validate ids, clamp numbers, and bound arrays before acting.

## Secrets

Declare every API key, token, or credential the project needs with
\`defineSecrets\`, then read it through the returned accessor. Never read
\`process.env\` directly and never hardcode a credential.

\`\`\`typescript
import { defineSecrets } from "@catamorphic/workflow";

export const secrets = defineSecrets({
  STRIPE_API_KEY: { description: "Stripe secret key" },
  REGION: { required: false, default: "eu-west-1" },
});

/**
 * @displayname Charge Card
 */
async function chargeCard({ amount }: { amount: number }) {
  "use step";
  await stripe(secrets.STRIPE_API_KEY).charge(amount);
}
\`\`\`

Rules:

1. Names are SCREAMING_SNAKE_CASE and must not start with \`CATAMORPHIC_\`.
2. Pass an inline object literal. A declaration built from a variable cannot be
   read from source and is a parse error.
3. Values are set per environment (test and production) outside the code. Never
   commit a value; declare the name and leave the value unset.
4. Reading an unset secret throws naming that secret, so no \`undefined\` checks
   are needed at the call site.
5. **Secrets are backend-only.** Never pass a secret to app code, return one
   from a workflow an app calls, or include one in a response. An app that needs
   a third-party API calls a workflow that holds the credential.
`,
  ".agents/skills/building-apps/SKILL.md": `---
name: building-apps
description: Builds and edits frontend apps that call this project's workflows. Use when creating an app, adding UI, wiring UI to workflows, exposing a workflow to apps, or changing the app contract.
---

# Building Apps

A project is a bun workspace with three kinds of member:

- \`contracts/\` — **types only, never runtime code.** The one package both
  sides may depend on.
- \`workflows/\` — backend code. Only this executes in a sandbox.
- \`apps/<name>/\` — one React frontend per directory, built by Vite to a
  single \`dist/app.js\` + \`dist/app.css\` and rendered by the host in a
  credential-less sandboxed iframe.

**Apps never import from \`workflows/\`.** The boundary is structural —
\`contracts/\` has no JavaScript to bundle — but respect it in your head
too: anything an app imports ships to every viewer's browser.

## The contract is the whole data path

1. Declare the shape in \`contracts/src/index.ts\`:

\`\`\`typescript
import type { DurableWorkflow, PlainWorkflow } from "@catamorphic/app";

export interface Order { id: string; total: number; placedAt: string }

export interface ListOrders {
  input: { status: "open" | "all" };
  output: Order[];
}

export interface AppContract {
  listOrders: PlainWorkflow<ListOrders>;
  reconcileLedger: DurableWorkflow<ReconcileLedger>;
}
\`\`\`

2. Implement and expose in \`workflows/src/app-api.ts\`:

\`\`\`typescript
import type { AppContract } from "@project/contracts";
import { listOrders } from "./orders.js";
import { reconcileLedger } from "./ledger.js";

export const appApi = { listOrders, reconcileLedger } satisfies AppContract;
\`\`\`

3. Call from the app:

\`\`\`typescript
import type { AppContract } from "@project/contracts";
import { createClient } from "@catamorphic/app";

const workflows = createClient<AppContract>();
const orders = await workflows.listOrders({ status: "open" });

const run = await workflows.reconcileLedger.start({ month: "2026-07" });
const outcome = await run.result(); // or run.poll() for progress
\`\`\`

Rules that keep this sound:

- **Presence in \`app-api.ts\` is the authorization.** Only workflows
  exported there are callable from apps — the set is frozen into each
  published version at build time. Entries must be plain identifier
  references to workflow functions (imports and renames are fine; computed
  or namespace access is a build error).
- Use \`PlainWorkflow\` for plain \`"use workflow"\` functions (they
  resolve inline — prefer these for reads) and \`DurableWorkflow\` for
  \`defineWorkflow\` definitions (they return a pollable handle; batch
  progress arrives through \`poll()\`).
- **Contracts must survive JSON.** No \`Date\`, \`Map\`, \`Set\`,
  functions, or \`undefined\` in inputs or outputs — the types reject them
  with a \`__catamorphicAppTypeError\` naming the field. Send ISO strings
  and plain objects; serialize deliberately.
- The \`satisfies AppContract\` line is what catches drift: change a
  workflow's real signature and \`workflows/\` fails to typecheck in the
  same commit. Never remove it or replace it with a cast.

## App-callable workflows receive untrusted input

A viewer controls the browser and can post any payload. Validate inside the
workflow before acting on input — check ids, clamp numbers, bound arrays.
Never pass secrets to app code, return one from an app-callable workflow, or
include one in an output. An app that needs a third-party API calls a
workflow that holds the credential.

## Creating an app

Scaffold \`apps/<name>/\` (kebab-case name) with \`package.json\`
(react, vite, \`@catamorphic/app\`; \`@project/contracts\` as a dev
dependency), \`vite.config.ts\` (IIFE lib mode, entry
\`src/main.tsx\`, output \`app.js\`/\`app.css\`), \`tsconfig.json\`
with \`"jsx": "react-jsx"\`, and \`src/main.tsx\` mounting into
\`#root\`. Copy an existing app's config when one exists.

The vite config MUST include
\`define: { "process.env.NODE_ENV": JSON.stringify("production") }\` —
lib mode does not inject it, and a bundle that still references
\`process.env\` at runtime ships dev-mode React (bigger and slower; the
host shims \`process\` so it runs, but never rely on that).

- One screen per app; no routing. The host controls where it renders.
- \`getContext()\` from \`@catamorphic/app\` gives the mount snapshot
  (tenant, user, host extras). Anything richer is one workflow call away.
- Verify with \`bun run build\` in the app directory: it must produce
  \`dist/app.js\` and typecheck clean. Fix contract errors at the source —
  never with \`any\` or \`@ts-ignore\`.
- You build and preview; a human publishes.
`,
  [BATCH_WORKFLOW_SKILL_PATH]: `---
name: batch-workflows
description: Creates and edits Catamorphic defineBatch scopes with paged sources, per-item processing, physical batch steps, retries, and idempotent sinks. Use when a Workflow handles many items or mentions batches, bulk processing, imports, exports, backfills, or large collections.
---

# Paged Batch Scopes

## Authoring contract

Inspect the project's imports and \`package.json\` before adding a
\`defineBatch\` scope:

- If the host provides a workflow wrapper package, import only the primitives
  that wrapper exposes.
- Otherwise add \`@catamorphic/workflow\` as an explicit dependency and import
  the primitives from it.
- Never create or copy a local \`workflows/src/batch.ts\` implementation.

A \`defineBatch\` scope has three phases:

1. \`source\` binds trigger input to a paged source.
2. \`process\` describes one logical item and may suspend at exported batch
   steps.
3. \`sink\` optionally writes terminal item outcomes in idempotent chunks and
   returns a final artifact.

## Workflow skeleton

\`\`\`typescript
import {
  defineBatchStep,
  defineWorkflow,
  skipBatchItem,
} from "@catamorphic/workflow";

interface RecordInput {
  id: string;
  value: string;
}

const recordsSource = {
  consistency: "snapshot",
  async initialize({ config }: { config: { prefix?: string } }) {
    return {
      snapshot: { capturedAt: new Date().toISOString() },
      cursor: 0,
      estimatedCount: undefined,
    };
  },
  async readPage({
    cursor = 0,
    limit,
  }: {
    cursor?: number;
    limit: number;
  }) {
    const records: readonly RecordInput[] = [];
    const page = records.slice(cursor, cursor + limit);
    const nextCursor = cursor + page.length;
    return {
      items: page.map((record) => ({ key: record.id, value: record })),
      nextCursor,
      done: nextCursor >= records.length,
    };
  },
};

/**
 * @displayname Enrich Records
 * @icon sparkles
 */
export const enrichRecords = defineBatchStep<
  { record: RecordInput },
  { enrichedValue: string }
>({
  batch: { maxItems: 50, maxWaitMs: 500, maxBytes: 128_000 },
  async run({ items }) {
    return items.map(({ key, value }) => ({
      key,
      status: "succeeded",
      result: { enrichedValue: value.record.value.trim() },
    }));
  },
});

const resultSink = {
  async initialize() {
    const writtenKeys: readonly string[] = [];
    return { writtenKeys };
  },
  async writeBatch({ records, state = { writtenKeys: [] } }) {
    const acknowledgedKeys = records.map((record) => record.key);
    return {
      state: {
        writtenKeys: [...new Set([...state.writtenKeys, ...acknowledgedKeys])],
      },
      acknowledgedKeys,
    };
  },
  async finalize({ state = { writtenKeys: [] }, summary }) {
    return { writtenKeys: state.writtenKeys, summary };
  },
};

/**
 * @displayname Process Records
 * @description Process a persisted collection of records
 */
export const processRecords = defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      source: ({ input }: { input: { prefix?: string } }) => ({
        source: recordsSource,
        config: { prefix: input.prefix },
      }),
      process: async ({ item }: { key: string; item: RecordInput }) => {
        if (item.value.trim() === "") {
          skipBatchItem({ reason: "Record value is empty" });
        }
        return enrichRecords({ record: item });
      },
      sink: resultSink,
    }),
  ],
}));
\`\`\`

## Source rules

- \`initialize\` captures a stable snapshot and initial cursor.
- \`readPage\` honors \`limit\`, returns stable keys, and advances the cursor.
- If \`done\` is false, return a next cursor.
- Never use array indexes as keys when the source has a stable identifier.

## Batch-step rules

- Export every \`defineBatchStep\`; workers target the export by name.
- \`maxItems\` bounds cohort size, \`maxWaitMs\` bounds collection delay, and
  \`maxBytes\` bounds serialized input size.
- Return one outcome per input key: \`succeeded\`, \`failed\`, or \`skipped\`.
- Mark transient failures \`retryable: true\`; permanent failures should not be
  retried.
- Keep outputs deterministic for the same item attempt. The coordinator replays
  completed steps when resuming an item.

## Sink rules

- Treat \`writeBatch\` as retryable and idempotent.
- Deduplicate by item key or chunk key before producing external side effects.
- Return every persistently written key in \`acknowledgedKeys\`.
- Keep sink state JSON-serializable.
- \`finalize\` returns the artifact shown to the host application.
`,
  [DURABLE_WORKFLOW_SKILL_PATH]: `---
name: durable-workflows
description: Creates and edits typed Catamorphic persisted scopes using defineWorkflow, defineBoundary, pause, retries, and child Workflows. Use when a Workflow mentions boundaries, waiting, pausing, resuming, retries, or child Workflows.
---

# Boundary and Pause Scopes

## Current status

The persisted-scope API is an authoring, visualization, and production-execution
contract. Each boundary runs as a separate invocation against one immutable
deployment artifact, while Postgres persists retries, pauses, child workflow
links, continuation state, and cancellation. Mutable-source test execution is
not supported, so deploy the Workflow before triggering it.

Import from the project's established SaaS wrapper when it exposes these
primitives; otherwise import from \`@catamorphic/workflow\`. Never copy the
helpers into the project.

When an existing direct dependency does not export \`defineWorkflow\`, update
it to the exact workflow package version used by the host or current template.
Do not recreate the types locally or bypass the missing API with assertions.

## Capability model

- \`defineWorkflow\` receives a builder callback.
- \`defineBoundary\` is available only on that builder context.
- \`pause\` and \`callWorkflow\` are available only in a boundary's
  \`BoundaryContext\`.
- A boundary is one atomic retry unit. If an attempt fails, all code in that
  boundary runs again. Ordinary \`"use step"\` functions called inside it may
  eventually be visualized, but are not separate persisted checkpoints.
- A returned transition resolves before the next boundary starts. The resolved
  value, not the transition object, is the next boundary's input.

## Complete pattern

\`\`\`typescript
import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";

interface OrderInput {
  orderId: string;
}

interface PreparedOrder {
  orderId: string;
  requestId: string;
}

interface Approval {
  approved: boolean;
}

interface ApprovalState extends PreparedOrder {}

const finishOrder = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<PreparedOrder>) => ({
        orderId: input.orderId,
        completed: true as const,
      }),
    }),
  ],
}));

export const approveOrder = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    /**
     * @displayname Request Approval
     * @description Create and wait for an approval request
     * @icon badge-check
     * @param orderId - @displayname Order ID | @description Order waiting for approval
     * @param requestedBy - @displayname Requested By | @description User requesting approval
     */
    defineBoundary({
      retry: {
        maxAttempts: 3,
        backoff: { initial: "1s", maximum: "30s", multiplier: 2 },
      },
      run: async ({ input }: BoundaryContext<OrderInput>) => ({
        orderId: input.orderId,
        requestId: \`request-\${input.orderId}\`,
      }),
    }),
    defineBoundary({
      run: ({ input, pause }: BoundaryContext<PreparedOrder>) =>
        pause<Approval, ApprovalState>({
          timeout: "24h",
          state: input,
        }),
    }),
    defineBoundary({
      run: ({ input, callWorkflow }: BoundaryContext<
        | {
            reason: "resumed";
            value: Approval;
            state: ApprovalState;
          }
        | { reason: "timed_out"; state: ApprovalState }
      >) => callWorkflow(finishOrder, { input: input.state }),
    }),
  ],
}));
\`\`\`

## Strict authoring rules

1. Annotate every callback parameter as \`BoundaryContext<Input>\`. This gives
   TypeScript a concrete input type for chain validation.
2. Return \`pause(...)\` and \`callWorkflow(...)\` directly. Never await them,
   store them for later, or ignore them; they are opaque instructions rather
   than promises.
   Destructure each capability from \`BoundaryContext\`; they are not package
   exports or globals.
3. Return \`callWorkflow(child, { input })\`, never \`child\` or a newly created
   \`defineWorkflow(...)\` value.
4. Keep workflow definitions static at module scope. Do not create workflows or
   boundaries inside \`run\`.
5. Boundary inputs and resolved outputs, pause values/state, and child workflow
   inputs/outputs must be JSON-compatible. Do not cross a boundary with
   functions, class instances with behavior, dates, maps, sets, promises,
   streams, or open resources.
6. Do not use \`any\`, assertions, or \`@ts-ignore\` to bypass workflow errors.
   Fix the boundary contract instead.
7. A pause without \`timeout\` can only resolve explicitly. A pause with
   \`timeout\` returns a union discriminated by \`reason: "resumed" |
   "timed_out"\`; handle both paths in the following boundary.
8. Cancellation is an authenticated, terminal host control. Use
   \`controls: { cancel: true }\` when the definition should declare that
   control. Never invent \`cancel()\` on \`BoundaryContext\`, and never add a
   canceled branch to \`PauseResult\`.
9. The parser requires an exported direct \`defineWorkflow\` call, an inline
   builder object, an inline \`steps\` array, direct \`defineBoundary\` entries,
   and inline \`run\` callbacks. Keep these structural parts static.
10. Workflows with persisted scopes and their boundaries use the same JSDoc
    metadata as plain functions and steps. Put \`@displayname\`,
    \`@description\`, \`@icon\`, and
    \`@param name - @displayname ... | @description ...\` immediately above the
    exported workflow definition or \`defineBoundary(...)\` array element.

## Understanding compiler errors

The API uses branded internal types, variadic tuples, conditional types, and
intentional \`__catamorphicWorkflowTypeError\` fields. TypeScript may print a
large structural error around a small workflow mistake. Find the quoted
Catamorphic message first, then inspect its details:

- \`Boundary N resolves to a value that boundary N+1 does not accept\` means
  boundary N's resolved return type is not assignable to the next annotated
  \`BoundaryContext<Input>\`. Compare \`resolvedOutput\` with \`nextInput\` in
  the diagnostic. Remember that a pause contributes its \`PauseResult\`, and a
  child call contributes the child workflow's output.
- \`A durable boundary input must be JSON-compatible\` means the
  \`BoundaryContext<Input>\` type cannot be persisted. Replace non-JSON fields
  with IDs or JSON data.
- \`A durable boundary must resolve to a JSON-compatible value\` means the
  callback returned a function, class instance, or other non-persistable value.
- \`Return callWorkflow(workflow, { input }) instead of returning a workflow
  definition\` means a static definition was returned as if it were a runtime
  transition.
- \`Workflow step N must be created by defineBoundary\` means the \`steps\`
  tuple contains a function, pause, workflow, promise, or other value instead
  of a boundary definition.
- A child-call property error means \`callWorkflow\` inferred the child's exact
  input. Supply every required field with the correct types; do not cast it.
- If \`input\` is \`unknown\` or inference becomes recursive, add or correct the
  explicit \`BoundaryContext<Input>\` annotation. Do not add generic arguments
  to \`defineWorkflow\` as a workaround.

Fix errors from the earliest boundary first because one incorrect return type
can cascade through every later tuple element. Run the project's TypeScript
check after each fix and remove temporary error suppressions.
`,
};

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: "orders-dashboard",
    name: "Orders Dashboard",
    description: "An app showing open orders, backed by workflows",
    defaultWorkflow: "listOpenOrders",
    files: {
      ...workspaceFiles({ name: "orders-dashboard" }),
      ...SEED_SKILLS,
      ...appScaffold({ name: "dashboard" }),
      "contracts/src/index.ts": `import type { PlainWorkflow } from "@catamorphic/app";

export interface Order {
  id: string;
  customer: string;
  total: number;
  placedAt: string;
}

export interface ListOpenOrders {
  input: { limit?: number };
  output: { orders: Order[] };
}

export interface MarkOrderShipped {
  input: { orderId: string };
  output: { shipped: boolean };
}

/** Everything apps may call. Implemented by workflows/src/app-api.ts. */
export interface AppContract {
  listOpenOrders: PlainWorkflow<ListOpenOrders>;
  markOrderShipped: PlainWorkflow<MarkOrderShipped>;
}
`,
      "contracts/package.json": JSON.stringify(
        {
          name: "@project/contracts",
          version: "1.0.0",
          private: true,
          type: "module",
          types: "./src/index.ts",
          exports: { ".": { types: "./src/index.ts" } },
          devDependencies: { "@catamorphic/app": APP_PACKAGE_VERSION },
        },
        null,
        2,
      ),
      "workflows/src/orders.ts": `import type { Order } from "@project/contracts";

/**
 * @displayname List Open Orders
 * @description Fetch open orders for the dashboard
 */
export async function listOpenOrders({ limit }: { limit?: number }) {
  "use workflow";
  const orders = await fetchOpenOrders({ limit: clampLimit({ limit }) });
  return { orders };
}

/**
 * @displayname Mark Order Shipped
 * @description Mark one order as shipped
 */
export async function markOrderShipped({ orderId }: { orderId: string }) {
  "use workflow";
  // App-callable workflows receive untrusted input: validate before acting.
  if (!/^ord_[a-z0-9]+$/.test(orderId)) {
    throw new Error("Invalid order id");
  }
  await shipOrder({ orderId });
  return { shipped: true };
}

function clampLimit({ limit }: { limit?: number }) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(Math.floor(limit), 100));
}

/**
 * @displayname Fetch Open Orders
 * @icon package
 * @param limit - @displayname Max Orders | @description Maximum number to return
 */
async function fetchOpenOrders({ limit }: { limit: number }): Promise<Order[]> {
  "use step";
  return Array.from({ length: Math.min(limit, 3) }, (_, index) => ({
    id: \`ord_\${index + 1}\`,
    customer: \`Customer \${index + 1}\`,
    total: (index + 1) * 42,
    placedAt: new Date(2026, 0, index + 1).toISOString(),
  }));
}

/**
 * @displayname Ship Order
 * @icon truck
 * @param orderId - @displayname Order ID | @description The order to ship
 */
async function shipOrder({ orderId }: { orderId: string }) {
  "use step";
}
`,
      "workflows/src/app-api.ts": `import type { AppContract } from "@project/contracts";
import { listOpenOrders, markOrderShipped } from "./orders.js";

/**
 * The app-facing contract surface. Only workflows exported here are callable
 * from apps; the set is frozen into each published app version at build time.
 */
export const appApi = { listOpenOrders, markOrderShipped } satisfies AppContract;
`,
      "apps/dashboard/src/app.tsx": `import type { AppContract, Order } from "@project/contracts";
import { createClient } from "@catamorphic/app";
import { useEffect, useState } from "react";

const workflows = createClient<AppContract>();

export function App() {
  const [orders, setOrders] = useState<readonly Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    workflows
      .listOpenOrders({ limit: 20 })
      .then((result) => setOrders(result.orders))
      .catch((cause: Error) => setError(cause.message));
  }, []);

  if (error) return <p>Could not load orders: {error}</p>;
  if (!orders) return <p>Loading orders…</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Order</th>
          <th>Customer</th>
          <th>Total</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id}>
            <td>{order.id}</td>
            <td>{order.customer}</td>
            <td>\${order.total}</td>
            <td>
              <button
                type="button"
                onClick={() => {
                  void workflows
                    .markOrderShipped({ orderId: order.id })
                    .then(() =>
                      setOrders(
                        (current) =>
                          current?.filter((entry) => entry.id !== order.id) ??
                          null,
                      ),
                    );
                }}
              >
                Ship
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
`,
      "apps/dashboard/src/main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./app.js";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
`,
    },
  },
  {
    id: "welcome-user",
    name: "Welcome New User",
    description: "Onboard a new user with welcome email and follow-up",
    defaultWorkflow: "welcomeUser",
    files: {
      ...workspaceFiles({ name: "welcome-user" }),
      ...SEED_SKILLS,
      "workflows/src/welcome.ts": `/**
 * @displayname Welcome New User
 * @description Onboard a new user with welcome email and follow-up
 */
export async function welcomeUser({
  email,
  name,
}: {
  email: string;
  name: string;
}) {
  "use workflow";

  const user = await createUser({ email, name });
  await sendWelcomeEmail({ to: user.email, name: user.name });

  if (user.plan === "premium") {
    await assignPremiumBenefits({ userId: user.id });
  }

  await sleep("7 days");
  await sendFollowUpEmail({ to: user.email });

  return { status: "complete", userId: user.id };
}

/**
 * @displayname Create User
 * @icon user-plus
 * @param email - @displayname Email Address | @description The user's primary email
 * @param name - @displayname Full Name | @description The user's display name
 */
async function createUser({ email, name }: { email: string; name: string }) {
  "use step";
  return { id: "usr_1", email, name, plan: "premium" };
}

/**
 * @displayname Send Welcome Email
 * @icon mail
 */
async function sendWelcomeEmail({ to, name }: { to: string; name: string }) {
  "use step";
}

/**
 * @displayname Assign Premium Benefits
 * @icon crown
 */
async function assignPremiumBenefits({ userId }: { userId: string }) {
  "use step";
}

/**
 * @displayname Send Follow-up Email
 * @icon mail
 */
async function sendFollowUpEmail({ to }: { to: string }) {
  "use step";
}

function sleep(_duration: string) {}
`,
    },
  },
  {
    id: "order-processing",
    name: "Order Processing",
    description:
      "Process an e-commerce order with parallel fulfillment and notifications",
    defaultWorkflow: "processOrder",
    files: {
      ...workspaceFiles({ name: "order-processing" }),
      ...SEED_SKILLS,
      "workflows/src/process-order.ts": `/**
 * @displayname Process Order
 * @description Process an e-commerce order end-to-end
 */
export async function processOrder({
  orderId,
  items,
  customerId,
}: {
  orderId: string;
  items: string[];
  customerId: string;
}) {
  "use workflow";

  const order = await validateOrder({ orderId, items });

  if (order.total > 500) {
    await flagForReview({ orderId, reason: "High value order" });
    await sleep("30 minutes");
  }

  const payment = await chargePayment({ orderId, amount: order.total });

  if (payment.status === "failed") {
    await notifyCustomer({ customerId, message: "Payment failed" });
    return { status: "payment_failed", orderId };
  }

  const [shipment] = await Promise.all([
    (async () => {
      const shipResult = await createShipment({ orderId, items });
      await notifyWarehouse({ shipmentId: shipResult.trackingId });
      return shipResult;
    })(),
    generateInvoice({ orderId, amount: order.total }),
  ]);

  for (const item of items) {
    await updateInventory({ itemId: item, delta: -1 });
  }

  await notifyCustomer({ customerId, message: "Order shipped!" });
  return { status: "complete", orderId, trackingId: shipment.trackingId };
}

/** @displayname Validate Order @icon shield */
async function validateOrder({ orderId, items }: { orderId: string; items: string[] }) {
  "use step";
  return { orderId, items, total: 750, valid: true };
}

/** @displayname Flag for Review @icon search */
async function flagForReview({ orderId, reason }: { orderId: string; reason: string }) {
  "use step";
}

/** @displayname Charge Payment @icon zap */
async function chargePayment({ orderId, amount }: { orderId: string; amount: number }) {
  "use step";
  return { status: "success", transactionId: "txn_123" };
}

/** @displayname Create Shipment @icon globe */
async function createShipment({ orderId, items }: { orderId: string; items: string[] }) {
  "use step";
  return { trackingId: "TRACK_123" };
}

/** @displayname Notify Warehouse @icon truck */
async function notifyWarehouse({ shipmentId }: { shipmentId: string }) {
  "use step";
}

/** @displayname Generate Invoice @icon file */
async function generateInvoice({ orderId, amount }: { orderId: string; amount: number }) {
  "use step";
  return { invoiceUrl: "https://example.com/invoice/123" };
}

/** @displayname Update Inventory @icon database */
async function updateInventory({ itemId, delta }: { itemId: string; delta: number }) {
  "use step";
}

/** @displayname Notify Customer @icon bell */
async function notifyCustomer({ customerId, message }: { customerId: string; message: string }) {
  "use step";
}

function sleep(_duration: string) {}
`,
    },
  },
  {
    id: "data-pipeline",
    name: "Data Sync Pipeline",
    description:
      "ETL pipeline with parallel extraction, transformation, and loading",
    defaultWorkflow: "dataSyncPipeline",
    files: {
      ...workspaceFiles({ name: "data-pipeline" }),
      ...SEED_SKILLS,
      "workflows/src/pipeline.ts": `import { extractFromSource } from "./steps/extract";
import { validateSchema, transformData } from "./steps/transform";
import { loadToDatabase, verifySync } from "./steps/load";
import { acquireLock, releaseLock, sendAlert } from "./steps/infra";

/**
 * @displayname Data Sync Pipeline
 * @description Extract, transform, and load data from multiple sources in parallel
 */
export async function dataSyncPipeline({
  sources,
  targetDb,
}: {
  sources: string[];
  targetDb: string;
}) {
  "use workflow";

  await acquireLock({ resource: targetDb });

  const [usersData, ordersData, productsData] = await Promise.all([
    extractFromSource({ source: "users-api", format: "json" }),
    extractFromSource({ source: "orders-db", format: "csv" }),
    extractFromSource({ source: "products-s3", format: "parquet" }),
  ]);

  for (const source of sources) {
    await validateSchema({ source, strict: true });
  }

  const transformed = await transformData({
    datasets: ["users", "orders", "products"],
    rules: "deduplicate,normalize,enrich",
  });

  if (transformed.errors > 0) {
    await sendAlert({ channel: "slack", message: "Transform errors detected" });
  }

  await loadToDatabase({ targetDb, batchSize: 1000 });
  await sleep("5 minutes");
  await verifySync({ targetDb, expectedCount: transformed.rowCount });
  await releaseLock({ resource: targetDb });

  return { status: "synced", rows: transformed.rowCount };
}

function sleep(_duration: string) {}
`,
      "workflows/src/steps/extract.ts": `/**
 * @displayname Extract from Source
 * @icon database
 */
export async function extractFromSource({ source, format }: { source: string; format: string }) {
  "use step";
  return { rows: 10000, source };
}
`,
      "workflows/src/steps/transform.ts": `/**
 * @displayname Validate Schema
 * @icon shield
 */
export async function validateSchema({ source, strict }: { source: string; strict: boolean }) {
  "use step";
}

/**
 * @displayname Transform Data
 * @icon code
 */
export async function transformData({ datasets, rules }: { datasets: string[]; rules: string }) {
  "use step";
  return { rowCount: 25000, errors: 0 };
}
`,
      "workflows/src/steps/load.ts": `/**
 * @displayname Load to Database
 * @icon database
 */
export async function loadToDatabase({ targetDb, batchSize }: { targetDb: string; batchSize: number }) {
  "use step";
}

/**
 * @displayname Verify Sync
 * @icon shield
 */
export async function verifySync({ targetDb, expectedCount }: { targetDb: string; expectedCount: number }) {
  "use step";
}
`,
      "workflows/src/steps/infra.ts": `/**
 * @displayname Acquire Lock
 * @icon settings
 */
export async function acquireLock({ resource }: { resource: string }) {
  "use step";
}

/**
 * @displayname Release Lock
 * @icon settings
 */
export async function releaseLock({ resource }: { resource: string }) {
  "use step";
}

/**
 * @displayname Send Alert
 * @icon bell
 */
export async function sendAlert({ channel, message }: { channel: string; message: string }) {
  "use step";
}
`,
    },
  },
  {
    id: "support-routing",
    name: "Support Ticket Routing",
    description:
      "Route incoming support tickets based on priority with nested branching",
    defaultWorkflow: "routeSupportTicket",
    files: {
      ...workspaceFiles({ name: "support-routing" }),
      ...SEED_SKILLS,
      "workflows/src/route-ticket.ts": `/**
 * @displayname Route Support Ticket
 * @description Route incoming support tickets to the right team based on priority level
 */
export async function routeSupportTicket({
  ticketId,
  priority,
  customerEmail,
}: {
  ticketId: string;
  priority: string;
  customerEmail: string;
}) {
  "use workflow";

  const ticket = await lookupTicket({ ticketId });

  if (ticket.priority === "critical") {
    await escalateToManager({ ticketId: ticket.id, reason: "Critical priority" });

    if (ticket.isVIP) {
      await assignDedicatedAgent({ ticketId: ticket.id });
      await notifyAccountManager({ ticketId: ticket.id });
    } else {
      await addToEscalationQueue({ ticketId: ticket.id });
    }
  } else if (ticket.priority === "high") {
    await assignToSenior({ ticketId: ticket.id });
  } else {
    await addToQueue({ ticketId: ticket.id, queue: "general" });
  }

  await sendAcknowledgment({ to: customerEmail, ticketId: ticket.id });
  return { status: "routed", ticketId: ticket.id };
}

/** @displayname Look Up Ticket @icon search */
async function lookupTicket({ ticketId }: { ticketId: string }) {
  "use step";
  return { id: ticketId, priority: "critical", subject: "Server down", isVIP: true, customerId: "cust_1" };
}

/** @displayname Escalate to Manager @icon alert-triangle */
async function escalateToManager({ ticketId, reason }: { ticketId: string; reason: string }) {
  "use step";
}

/** @displayname Assign Dedicated Agent @icon star */
async function assignDedicatedAgent({ ticketId }: { ticketId: string }) {
  "use step";
}

/** @displayname Notify Account Manager @icon bell */
async function notifyAccountManager({ ticketId }: { ticketId: string }) {
  "use step";
}

/** @displayname Add to Escalation Queue @icon alert-circle */
async function addToEscalationQueue({ ticketId }: { ticketId: string }) {
  "use step";
}

/** @displayname Assign to Senior @icon user-check */
async function assignToSenior({ ticketId }: { ticketId: string }) {
  "use step";
}

/** @displayname Add to Queue @icon inbox */
async function addToQueue({ ticketId, queue }: { ticketId: string; queue: string }) {
  "use step";
}

/** @displayname Send Acknowledgment @icon mail */
async function sendAcknowledgment({ to, ticketId }: { to: string; ticketId: string }) {
  "use step";
}
`,
    },
  },
  {
    id: "durable-order-approval",
    name: "Order Approval with Retries",
    description:
      "Visualize retry boundaries, resumable approval, child workflows, and cancellation",
    defaultWorkflow: "approveOrder",
    files: {
      ...workspaceFiles({
        name: "durable-order-approval",
        dependencies: {
          "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
        },
      }),
      ...SEED_SKILLS,
      "workflows/src/approve-order.ts": `import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";
import { finishOrder } from "./finish-order";

interface OrderInput {
  orderId: string;
  requestedBy: string;
}

interface PreparedOrder {
  orderId: string;
  requestId: string;
}

interface Approval {
  approved: boolean;
  reviewerId: string;
}

/**
 * @displayname Approve Order
 * @description Request a resumable approval before finishing an order
 * @param orderId - @displayname Order ID | @description Order waiting for approval
 * @param requestedBy - @displayname Requested By | @description User requesting approval
 */
export const approveOrder = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    /**
     * @displayname Request Approval
     * @description Create and wait for an approval request
     * @icon badge-check
     * @param orderId - @displayname Order ID | @description Order waiting for approval
     * @param requestedBy - @displayname Requested By | @description User requesting approval
     */
    defineBoundary({
      retry: {
        maxAttempts: 3,
        backoff: { initial: "1s", maximum: "30s", multiplier: 2 },
      },
      run: async ({ input, pause }: BoundaryContext<OrderInput>) => {
        const prepared = await createApprovalRequest({
          orderId: input.orderId,
          requestedBy: input.requestedBy,
        });
        return pause<Approval, PreparedOrder>({
          timeout: "24h",
          state: prepared,
        });
      },
    }),
    /**
     * @displayname Finish Approved Order
     * @description Continue into the child workflow after approval or timeout
     * @icon workflow
     */
    defineBoundary({
      run: ({ input, callWorkflow }: BoundaryContext<
        | { reason: "resumed"; value: Approval; state: PreparedOrder }
        | { reason: "timed_out"; state: PreparedOrder }
      >) => callWorkflow(finishOrder, { input: input.state }),
    }),
  ],
}));

/**
 * @displayname Create Approval Request
 * @icon badge-check
 */
async function createApprovalRequest({
  orderId,
  requestedBy,
}: {
  orderId: string;
  requestedBy: string;
}): Promise<PreparedOrder> {
  "use step";
  return { orderId, requestId: \`approval-\${requestedBy}\` };
}
`,
      "workflows/src/finish-order.ts": `import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";

interface PreparedOrder {
  orderId: string;
  requestId: string;
}

/** @displayname Finish Order */
export const finishOrder = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    /**
     * @displayname Finalize Order
     * @description Mark the approved order complete
     * @icon badge-check
     * @param orderId - @displayname Order ID | @description Approved order to finish
     * @param requestId - @displayname Request ID | @description Completed approval request
     */
    defineBoundary({
      run: async ({ input }: BoundaryContext<PreparedOrder>) => {
        await markOrderApproved({ orderId: input.orderId });
        return { orderId: input.orderId, completed: true };
      },
    }),
  ],
}));

/** @displayname Mark Order Approved @icon badge-check */
async function markOrderApproved({ orderId }: { orderId: string }) {
  "use step";
}
`,
    },
  },
  {
    id: "customer-feedback-analysis",
    name: "Customer Feedback Analysis",
    description:
      "Analyze seeded customer feedback in a paged batch scope and produce a summary artifact",
    defaultWorkflow: "analyzeCustomerFeedback",
    files: {
      ...workspaceFiles({
        name: "customer-feedback-analysis",
        dependencies: {
          "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
        },
      }),
      ...SEED_SKILLS,
      "workflows/src/customer-feedback.ts": `import {
  type BatchConsistency,
  defineBatchStep,
  defineWorkflow,
  skipBatchItem,
} from "@catamorphic/workflow";

interface Feedback {
  id: string;
  rating: number;
  comment: string;
}

interface NormalizedFeedback extends Feedback {
  normalizedComment: string;
}

interface FeedbackAnalysis {
  sentiment: "positive" | "neutral" | "negative";
  topic: "product" | "support" | "pricing";
}

const COMMENTS: readonly string[] = [
  "The product is fast and delightful.",
  "Support took too long to reply.",
  "Great value for the price.",
  "The product works as expected.",
  "Pricing is confusing and expensive.",
  "Support solved my issue immediately.",
];

const FEEDBACK_SOURCE_CONSISTENCY: BatchConsistency = "snapshot";

const SEEDED_FEEDBACK: readonly Feedback[] = Array.from(
  { length: 320 },
  (_, index) => ({
    id: \`fb-\${String(index + 1).padStart(3, "0")}\`,
    rating: (index % 5) + 1,
    comment: index > 0 && index % 79 === 0 ? "" : COMMENTS[index % COMMENTS.length] ?? "",
  }),
);

const feedbackSource = {
  consistency: FEEDBACK_SOURCE_CONSISTENCY,
  async initialize({
    config,
  }: {
    config: { minimumRating: number };
  }) {
    const matching = SEEDED_FEEDBACK.filter(
      (feedback) => feedback.rating >= config.minimumRating,
    );
    return {
      snapshot: { highWaterMark: matching.length },
      cursor: 0,
      estimatedCount: matching.length,
    };
  },
  async readPage({
    config,
    snapshot,
    cursor = 0,
    limit,
  }: {
    config: { minimumRating: number };
    snapshot: { highWaterMark: number };
    cursor?: number;
    limit: number;
  }) {
    const matching = SEEDED_FEEDBACK.filter(
      (feedback) => feedback.rating >= config.minimumRating,
    ).slice(0, snapshot.highWaterMark);
    const page = matching.slice(cursor, cursor + limit);
    const nextCursor = cursor + page.length;
    return {
      items: page.map((feedback) => ({
        key: feedback.id,
        value: feedback,
      })),
      nextCursor,
      done: nextCursor >= matching.length,
    };
  },
};

/**
 * @displayname Classify Feedback
 * @icon messages-square
 */
export const classifyFeedback = defineBatchStep<
  { feedback: NormalizedFeedback },
  FeedbackAnalysis
>({
  batch: { maxItems: 32, maxWaitMs: 250, maxBytes: 64_000 },
  async run({ items }) {
    return items.map(({ key, value, attempt }) => {
      if (key === "fb-042" && attempt === 1) {
        return {
          key,
          status: "failed",
          error: {
            message: "Seeded transient classifier failure",
            retryable: true,
          },
        };
      }
      const text = value.feedback.normalizedComment;
      const sentiment =
        value.feedback.rating >= 4
          ? "positive"
          : value.feedback.rating <= 2
            ? "negative"
            : "neutral";
      const topic = text.includes("support")
        ? "support"
        : text.includes("price") || text.includes("pricing")
          ? "pricing"
          : "product";
      return { key, status: "succeeded", result: { sentiment, topic } };
    });
  },
});

const summarySink = {
  async initialize() {
    const results: { key: string; sentiment: string; topic: string }[] = [];
    return { results };
  },
  async writeBatch({
    records,
    state = { results: [] },
  }: {
    records: readonly {
      key: string;
      outcome: {
        status: string;
        result?: FeedbackAnalysis;
      };
    }[];
    state?: {
      results: { key: string; sentiment: string; topic: string }[];
    };
  }) {
    const written = records.flatMap((record) =>
      record.outcome.status === "succeeded" && record.outcome.result
        ? [{ key: record.key, ...record.outcome.result }]
        : [],
    );
    const retained = state.results.filter(
      (result) => !written.some((candidate) => candidate.key === result.key),
    );
    return {
      state: { results: [...retained, ...written] },
      acknowledgedKeys: records.map((record) => record.key),
    };
  },
  async finalize({
    state = { results: [] },
    summary,
  }: {
    state?: {
      results: { key: string; sentiment: string; topic: string }[];
    };
    summary: {
      total: number;
      succeeded: number;
      failed: number;
      skipped: number;
    };
  }) {
    const rows = state.results.map(
      (result) =>
        \`\${result.key},\${result.sentiment},\${result.topic}\`,
    );
    return {
      fileName: "customer-feedback-analysis.csv",
      contentType: "text/csv",
      content: ["key,sentiment,topic", ...rows].join("\\n"),
      summary,
    };
  },
};

/**
 * @displayname Analyze Customer Feedback
 * @description Classify seeded customer feedback in efficient physical batches
 */
export const analyzeCustomerFeedback = defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      source: ({
        input,
      }: {
        input: { minimumRating?: number };
      }) => ({
        source: feedbackSource,
        config: { minimumRating: input.minimumRating ?? 1 },
      }),
      process: async ({
        item,
      }: {
        key: string;
        item: Feedback;
      }) => {
        const validation = await validateFeedback({ feedback: item });
        if (!validation.valid) {
          skipBatchItem({ reason: validation.reason });
        }
        const normalized = await normalizeFeedback({ feedback: item });
        return classifyFeedback({ feedback: normalized });
      },
      sink: summarySink,
    }),
  ],
}));

/**
 * @displayname Validate Feedback
 * @icon badge-check
 * @param feedback - @displayname Customer Feedback | @description Seeded feedback to validate
 */
async function validateFeedback({
  feedback,
}: {
  feedback: Feedback;
}): Promise<{ valid: true } | { valid: false; reason: string }> {
  "use step";
  if (feedback.comment.trim() === "") {
    return { valid: false, reason: "Feedback comment is empty" };
  }
  return { valid: true };
}

/**
 * @displayname Normalize Feedback
 * @icon wand-sparkles
 * @param feedback - @displayname Customer Feedback | @description Raw seeded feedback record
 */
async function normalizeFeedback({
  feedback,
}: {
  feedback: Feedback;
}): Promise<NormalizedFeedback> {
  "use step";
  return {
    ...feedback,
    normalizedComment: feedback.comment.trim().toLowerCase(),
  };
}
`,
    },
  },
];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
