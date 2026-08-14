import { APP_THEME_COLOR_TOKENS } from "@catamorphic/app";
import { PARSER_PACKAGE_VERSION } from "@catamorphic/parser";
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

const rootWorkspacePkg = (name: string) =>
  JSON.stringify(
    {
      name,
      version: "1.0.0",
      private: true,
      workspaces: ["contracts", "workflows", "apps/*"],
      scripts: { check: "bun scripts/check.ts" },
      // Dev-only tooling for the seeded check script; stripped from every
      // sandbox install.
      devDependencies: { "@catamorphic/parser": PARSER_PACKAGE_VERSION },
    },
    null,
    2,
  );

const contractsPkg = JSON.stringify(
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
);

const workflowsPkg = (dependencies?: Record<string, string>) =>
  pkg({
    name: "@project/workflows",
    dependencies: {
      "@project/contracts": "workspace:*",
      ...dependencies,
    },
  });

/**
 * Workspace scaffolding shared by every template. A project is a bun workspace
 * so one repo holds backend workflows and frontend apps, with `contracts` as
 * the only package both sides depend on. This is the ONE canonical scaffold:
 * blank projects don't get it at creation (ADR 0043 — the workspace appears
 * on demand, installed by templates or by agents via the `catamorphic-projects`
 * seed skill, whose support files are generated from these same constants).
 */
export const workspaceFiles = ({
  name,
  dependencies,
}: {
  name: string;
  dependencies?: Record<string, string>;
}): Record<string, string> => ({
  "package.json": rootWorkspacePkg(name),
  [PROJECT_CHECK_SCRIPT_PATH]: PROJECT_CHECK_SCRIPT,
  "contracts/package.json": contractsPkg,
  "contracts/tsconfig.json": SHARED_TSCONFIG,
  "contracts/src/index.ts": CONTRACTS_INDEX,
  "workflows/package.json": workflowsPkg(dependencies),
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

export const APP_PACKAGE_VERSION = "0.0.3";

/** Where the seeded project check script lives; owned by the project. */
export const PROJECT_CHECK_SCRIPT_PATH = "scripts/check.ts";

/**
 * The seeded check script. Thin by design: everything it calls ships in
 * `@catamorphic/parser`, so projects can rewrite the script without losing
 * validation, and the script works anywhere bun runs — a laptop, CI — with
 * no Catamorphic host.
 */
export const PROJECT_CHECK_SCRIPT = `/**
 * Project check — parses this workspace, validates workflows and trigger
 * bindings, and verifies the generated app-api types are fresh.
 *
 * Seeded by Catamorphic, owned by this project: edit it freely. The heavy
 * lifting lives in the \`@catamorphic/parser\` devDependency; this script is
 * just the how-to-run-it. (Missing the dependency? \`bun install\` at the
 * workspace root, or \`bun add -d @catamorphic/parser\`.)
 *
 * Usage:
 *   bun run check                # validate (exit 1 on errors) — CI-friendly
 *   bun run check -- --write     # also (re)write generated app-api types
 *   bun run check -- --host URL  # validate trigger bindings against a
 *                                # running Catamorphic host (GET /api/trigger-kinds)
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkProject, type CheckTriggerKind } from "@catamorphic/parser";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

async function collectFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(full);
        continue;
      }
      const relative = path.relative(root, full).split(path.sep).join("/");
      files[relative] = await readFile(full, "utf8").catch(() => "");
    }
  }
  await walk(root);
  return files;
}

const write = process.argv.includes("--write");
const hostFlagIndex = process.argv.indexOf("--host");
const host = hostFlagIndex >= 0 ? process.argv[hostFlagIndex + 1] : undefined;

let triggerKinds: CheckTriggerKind[] | undefined;
if (host) {
  const response = await fetch(new URL("/api/trigger-kinds", host));
  if (!response.ok) {
    console.error(\`Could not fetch trigger kinds from \${host}: \${response.status}\`);
    process.exit(1);
  }
  triggerKinds = (await response.json()) as CheckTriggerKind[];
}

const files = await collectFiles(process.cwd());
const result = checkProject(files, { triggerKinds });

const written = new Set<string>();
if (write) {
  for (const [relative, content] of Object.entries(result.generated)) {
    if (files[relative] !== content) {
      await mkdir(path.dirname(relative), { recursive: true });
      await writeFile(relative, content);
      written.add(relative);
      console.log(\`wrote \${relative}\`);
    }
  }
}

let failed = false;
for (const finding of result.findings) {
  if (finding.file && written.has(finding.file)) continue; // fixed by --write
  if (finding.level === "error") failed = true;
  const prefix = finding.level === "error" ? "error" : "warn ";
  console.log(\`\${prefix} \${finding.file ? \`\${finding.file}: \` : ""}\${finding.message}\`);
}
console.log(failed ? "check failed" : "check passed");
process.exit(failed ? 1 : 0);
`;

export const BATCH_WORKFLOW_SKILL_PATH =
  ".agents/skills/batch-workflows/SKILL.md";
export const DURABLE_WORKFLOW_SKILL_PATH =
  ".agents/skills/durable-workflows/SKILL.md";

const SCAFFOLD_SKILL_DIR = ".agents/skills/catamorphic-projects";

/**
 * The workspace scaffold shipped as support files of the
 * `catamorphic-projects` seed skill, so an agent can install the workspace
 * into a project that has none by copying files instead of reconstructing
 * them from memory. Generated from the same constants as the template
 * scaffold (`workspaceFiles`) — the two cannot drift.
 */
const scaffoldSupportFiles = (): Record<string, string> => ({
  [`${SCAFFOLD_SKILL_DIR}/files/package.json`]: rootWorkspacePkg("my-project"),
  [`${SCAFFOLD_SKILL_DIR}/files/check.ts`]: PROJECT_CHECK_SCRIPT,
  [`${SCAFFOLD_SKILL_DIR}/files/contracts.package.json`]: contractsPkg,
  [`${SCAFFOLD_SKILL_DIR}/files/tsconfig.json`]: SHARED_TSCONFIG,
  [`${SCAFFOLD_SKILL_DIR}/files/contracts.index.ts`]: CONTRACTS_INDEX,
  [`${SCAFFOLD_SKILL_DIR}/files/workflows.package.json`]: workflowsPkg({
    "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
  }),
});

/**
 * Per-project agent skills seeded into every project (templates and blank
 * ones alike). Skills live in the project repo under
 * `.agents/skills/<name>/SKILL.md` (Agent Skills spec) so they are versioned
 * with the code, scoped per project, and read by coding agents from the dev
 * sandbox checkout. The workflow skills are reference material — consulted
 * only when workflow work happens; seeding them does not make a project a
 * workflow codebase (ADR 0043).
 */
export const SEED_SKILLS: Record<string, string> = {
  [`${SCAFFOLD_SKILL_DIR}/SKILL.md`]: `---
name: catamorphic-projects
description: What a Catamorphic project can hold, and how to add the automations/apps workspace to a project that has none. Use when the user asks for their first workflow, automation, or app in this project, or asks what this project is.
---

# Catamorphic projects

A Catamorphic project is a folder that can hold any kind of work — documents, notes, data, plans, code, automations (workflows), and user-facing apps, in any mix. Never assume the project is about code or automations: read what is actually there first.

Hidden metadata lives in \`.catamorphic/\` (the project manifest and project-scoped config) and \`.agents/\` (these skills). Everything visible in the tree is the user's own work — keep it that way.

## Adding automations or apps to a project that has none

Workflows and apps live in a bun workspace: a root \`package.json\` with \`"workspaces": ["contracts", "workflows", "apps/*"]\`. If \`workflows/package.json\` does not exist yet, install the workspace BEFORE writing the first workflow, by copying this skill's support files (in \`files/\` next to this document) into place:

| Copy | To |
|---|---|
| \`files/package.json\` | \`package.json\` (project root) |
| \`files/check.ts\` | \`scripts/check.ts\` |
| \`files/contracts.package.json\` | \`contracts/package.json\` |
| \`files/tsconfig.json\` | \`contracts/tsconfig.json\` AND \`workflows/tsconfig.json\` |
| \`files/contracts.index.ts\` | \`contracts/src/index.ts\` |
| \`files/workflows.package.json\` | \`workflows/package.json\` |

Then:

1. Set the root \`package.json\` \`"name"\` to the project's name. If a root \`package.json\` already exists (imported code projects), merge instead of replacing: keep every existing field and add \`workspaces\`, \`scripts.check\`, and the \`@catamorphic/parser\` devDependency.
2. Run \`bun install\` at the project root.
3. Consult \`.agents/skills/writing-workflows/SKILL.md\` before writing workflow code, and \`.agents/skills/building-apps/SKILL.md\` before creating an app under \`apps/<name>/\`.

Do NOT install the workspace preemptively — only when automations or apps are actually wanted.
`,
  ".agents/skills/writing-workflows/SKILL.md": `---
name: writing-workflows
description: Writes and edits Catamorphic Workflows as exported defineWorkflow definitions with boundary and batch scopes. Use when creating workflows, adding steps, changing workflow logic, or choosing capabilities.
---

# Writing Workflows

## The one authoring model

Every workflow is an exported \`defineWorkflow(...)\` value whose ordered
\`steps\` use the builder-scoped \`defineBoundary\` and \`defineBatch\`:

- **Boundaries** hold orchestration code. A single boundary is enough for most
  workflows; add more boundaries for explicit retry policies, pauses, or child
  workflow calls.
- **Batches** handle persisted paged collections, bounded concurrency, physical
  batching, progress, or resumable output.
- **\`"use step"\` functions** hold IO and business operations. They are plain
  async functions called from boundary run bodies and batch process callbacks.

Do not add a batch scope merely to process an array supplied in one request.

## Shared rules

1. Every workflow boundary and step takes one destructured object parameter.
2. Every UI-facing workflow, step, and parameter has JSDoc metadata with
   \`@displayname\`; steps may also use \`@icon\`.
3. Keep orchestration code simple: awaited calls, \`if\`/\`else\`, loops, and
   \`Promise.all\` inside boundary run bodies. The visual graph is derived from
   this structure.
4. Put IO and business operations in \`"use step"\` functions. Keep boundary
   run bodies declarative.
5. After structural edits (new workflows, changed inputs/outputs, app-api
   changes), run \`bun run check\` at the workspace root. It validates the
   parse, trigger bindings, and generated types; \`--write\` refreshes the
   generated app-api types.

## A minimal workflow

\`\`\`typescript
import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";

/**
 * @displayname Greet User
 * @description Send a greeting to a user
 * @param email - @displayname Email Address | @description Who to greet
 */
export const greetUser = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ email: string }>) => {
        await sendGreeting({ to: input.email });
        return { status: "sent" };
      },
    }),
  ],
}));

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
or substantially editing boundaries, pauses, or child calls. Workflows
execute in production with persisted continuation state.

## App-callable workflows

Read [the building-apps skill](../building-apps/SKILL.md) before exposing a
workflow to apps or editing \`workflows/src/app-api.ts\`. Key rules:

- A workflow is app-callable only when exported from \`app-api.ts\`; keep
  that surface minimal and deliberate.
- App-facing reads should be workflows that cannot suspend — no pause,
  retry, rate limit, or batch scope — so the client's \`.call()\` settles
  them inline. Long-running workflows are started with \`.start()\` and
  polled through the returned handle.
- Inputs and outputs must survive JSON: no dates, maps, sets, functions, or
  \`undefined\`. Send ISO strings and plain objects.
- App-callable workflows receive untrusted input from a viewer's browser.
  Validate ids, clamp numbers, and bound arrays before acting.

## Host triggers

The embedding host can define custom trigger kinds — "Ticket Created",
"AI Tool Call", "Chat Turn" — and fire them with a payload; every
workflow subscribed to that kind runs with the payload as input.

\`\`\`typescript
import { defineWorkflow, trigger } from "@catamorphic/workflow";

export const escalateTicket = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ticket.created", { onlyPriority: "high" })],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ ticketId: string }>) => ({
        escalated: input.ticketId,
      }),
    }),
  ],
}));
\`\`\`

Rules:

1. Triggers are declared in the definition's inline \`triggers\` array,
   alongside \`steps\`.
2. The kind name must be a string literal and the config an inline constant
   (object/array/string/number/boolean literals). Hosts introspect the config
   without running code, so anything computed is a parse error.
3. Valid kind names, payload types, and config shapes come from the generated
   \`workflows/src/catamorphic-triggers.d.ts\`. Never edit that file. If
   \`trigger()\` rejects every kind name, the file is missing or stale — the
   host syncs it; do not hand-write a replacement.
4. The trigger payload becomes the first step's input, so the first
   \`BoundaryContext<Input>\` must accept the kind's payload type. Multiple
   bindings are allowed; the input must then accept every payload.
5. Some kinds are parameterized: their payload (or parts of it) shows as
   \`Hole<"Name">\` in the generated types. A hole means "this workflow's
   own input type defines the shape here" — so give the input a concrete,
   descriptive type; \`any\` or \`unknown\` at a hole fails the deploy. For
   an AI tool-call kind, that input type IS the tool's argument schema the
   model sees.
6. Each kind defines what its config means (e.g. an AI tool-call kind requires
   a \`description\` the model sees). Fill it thoughtfully — hosts read it.
7. Hosts may fire sync (result awaited inline) or async. A workflow with no
   pause, retry, rate limit, batch, or child call is guaranteed to complete
   inline; anything else may detach mid-run, which is fine and expected.

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
import type { Workflow } from "@catamorphic/app";

export interface Order { id: string; total: number; placedAt: string }

export interface ListOrders {
  input: { status: "open" | "all" };
  output: Order[];
}

export interface AppContract {
  listOrders: Workflow<ListOrders>;
  reconcileLedger: Workflow<ReconcileLedger>;
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
const orders = await workflows.listOrders.call({ status: "open" });

const run = await workflows.reconcileLedger.start({ month: "2026-07" });
const outcome = await run.result(); // or run.poll() for progress
\`\`\`

When a generated \`src/catamorphic-app-api.d.ts\` exists in the app
workspace, prefer its \`ProjectAppApi\` over a hand-written contract — it is
projected from \`app-api.ts\` and the workflows' actual input/output types,
so it cannot drift:

\`\`\`typescript
import type { ProjectAppApi } from "./catamorphic-app-api.js";
const workflows = createClient<ProjectAppApi>();
\`\`\`

Never edit that file; it is regenerated by the host.

Rules that keep this sound:

- **Presence in \`app-api.ts\` is the authorization.** Only workflows
  exported there are callable from apps — the set is frozen into each
  published version at build time. Entries must be plain identifier
  references to workflow functions (imports and renames are fine; computed
  or namespace access is a build error).
- Every contract entry is \`Workflow<T>\`. Each client method exposes
  \`.call(input)\` (runs the workflow and waits for its terminal output)
  and \`.start(input)\` (returns a pollable run handle; batch progress
  arrives through \`poll()\`). Reads should be workflows that cannot
  suspend — no pause, retry, rate limit, or batch — so \`.call()\` settles
  them inline; use \`.start()\` for anything long-running.
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

## Design system: the app UI kit

Apps render inside a host application and must look and feel like part
of it. **Build the UI from \`@catamorphic/app/ui\`** — polished React
components pre-styled to the host application's theme: the kit adapts to
whatever host mounts the app. The host injects the
kit stylesheet and the user's active theme into every app document (and
updates the theme live), so components need no CSS imports and no theme
plumbing; light, dark, and fully custom user themes all come free:

\`\`\`typescript
import { Button, Card, DataTable, useAsync } from "@catamorphic/app/ui";
\`\`\`

### Component inventory

| Component | Props (essentials) | Use |
|---|---|---|
| \`Button\` | \`variant\` primary/ghost/danger/subtle, \`size\` sm/md, \`loading\`, \`loadingLabel\` | Actions. \`loading\` shows a spinner and disables WITHOUT changing width — use it for every workflow call a button starts. |
| \`Field\` | \`label\`, \`hint\`, \`error\` | Wrap one control; ids and aria wiring are automatic. \`error\` replaces the hint and turns the control invalid. |
| \`Input\` / \`Textarea\` | \`invalid\` + native props | Text entry on the inset surface. |
| \`Select\` | \`invalid\` + native props; \`<option>\` children | Styled native select — free keyboard/screen-reader behavior. |
| \`Checkbox\` | native props | Styled native checkbox. |
| \`Switch\` | \`checked\`, \`onCheckedChange\` | On/off toggle (\`role=switch\`). |
| \`Card\` | \`title\`, \`description\`, \`footer\` | THE surface unit — compose screens from Cards on the app background. |
| \`Tabs\`+\`TabList\`+\`Tab\`+\`TabPanel\` | \`value\`, \`onValueChange\`; \`value\` per tab/panel | Underline tabs with roving keyboard focus. |
| \`Badge\` | \`variant\` neutral/success/warning/danger/info | 11px low-chroma status label. |
| \`Spinner\` | \`size\`, \`label\` | Indeterminate progress. |
| \`Skeleton\` | \`width\`, \`height\` | Loading placeholder with shimmer. |
| \`EmptyState\` | \`message\`, \`action\` | The quiet empty state: one muted sentence + one action, max. |
| \`ErrorState\` | \`code\`, \`message\`, \`onRetry\` | Failure state; \`code\` maps via the exported \`ERROR_STATE_COPY\` (extend it for project codes). |
| \`KeyValueRow\` / \`KeyValueList\` | \`label\`, children | Label/value lines that truncate correctly in narrow columns. |
| \`Dialog\` | \`open\`, \`onClose\`, \`title\`, \`description\`, \`footer\`, \`closeOnOverlayClick\` | Modal with focus trap/restore, Esc, and the host's enter/exit motion. |
| \`Tooltip\` | \`label\`, \`delay\` | Hover/focus hint (~500ms delay — never instant). |
| \`DataTable\` | \`columns\` (\`key\`/\`header\`/\`align\`/\`width\`/\`sortable\`/\`render\`), \`rows\`, \`rowKey\`, \`loading\`, \`empty\`, \`truncated\`, \`maxHeight\` | The table: sticky header, client-side sorting, host-density rows, skeleton/empty/truncated states built in. Plain \`Table\`/\`TableRow\`/… also exported for hand-rolled cases. |
| \`DatePicker\` / \`DateRangePicker\` | \`value\` (ISO \`YYYY-MM-DD\` / \`{from,to}\`), \`onChange\`, \`placeholder\` | Date entry — popover calendar, keyboard-navigable, date-only local strings (JSON-safe). |
| \`Calendar\` | \`mode\`, \`value\`, \`onSelect\` | The bare month grid when you need it inline. |
| \`ScrollHint\` | \`fadeColor\` (match the surface behind) | Scroll container that fades edges with more content. |
| \`useAsync(load, deps)\` | returns \`{status:"loading"} \\| {status:"error",error,retry} \\| {status:"ok",value}\` | Load workflow data into the three states below. |

### The three data states

Every screen that loads data has exactly three states, and the kit covers
all of them: \`Skeleton\` (or \`DataTable loading\`) while loading,
\`ErrorState\` with retry on failure, \`EmptyState\` when the result is
empty. Wire them with \`useAsync\`:

\`\`\`typescript
import { DataTable, ErrorState, useAsync } from "@catamorphic/app/ui";

function Orders() {
  const orders = useAsync(
    () => workflows.listOpenOrders.call({ limit: 50 }),
    [],
  );
  if (orders.status === "error") return <ErrorState onRetry={orders.retry} />;
  return (
    <DataTable
      columns={[
        { key: "customer", header: "Customer", sortable: true },
        { key: "total", header: "Total", align: "right", sortable: true },
      ]}
      rows={orders.status === "ok" ? orders.value.orders : []}
      rowKey={(order) => order.id}
      loading={orders.status === "loading"}
      empty="No open orders."
    />
  );
}
\`\`\`

### Layout doctrine

- Space on a **4px grid** (4/8/12/16). Base type is the host's base size,
  already set on \`body\` along with the background, text color, and font —
  do not restyle them.
- \`Card\` is the surface unit. Bare custom surfaces, when needed, are
  \`var(--color-bg-raised)\` + 1px \`var(--color-border)\` +
  \`var(--radius-lg)\`; inputs and wells use \`--color-bg-inset\`.
- Colors ONLY through the theme tokens: ${APP_THEME_COLOR_TOKENS.map((token) => `\`--color-${token}\``).join(", ")}.
  Fonts \`--font-sans\`/\`--font-mono\`; radii \`--radius-sm/md/lg\`; the
  one easing \`--ease-standard\`; type size \`--cat-font-size\` (small
  labels \`--cat-font-size-sm\`); row density \`--cat-row-h\`; motion
  durations \`--cat-motion-fast/base/slow\`. All are set by the host —
  never hardcode a value one of them covers.
- Secondary text is \`--color-fg-muted\`, hints \`--color-fg-faint\`.
- **One primary action per view** (\`Button variant="primary"\`);
  everything else is ghost or subtle.

### Motion doctrine

The kit animates itself — dialogs, popovers, tooltips, spinners already
follow the host's motion contract. Apps add NO animation beyond color
transitions on their own hover states
(\`var(--cat-motion-fast) var(--ease-standard)\`).
Nothing loops, nothing bounces, nothing animates on load.

### Forms

A native \`<form>\` submit REALLY NAVIGATES the sandboxed app frame: the
sandbox allows forms, and the CSP's \`form-action\` does not inherit from
\`default-src\`, so nothing blocks it — the app reloads from scratch and
loses all state (verified; Enter in any input triggers it via implicit
submission). **Always \`event.preventDefault()\` in \`onSubmit\`** and call
workflows through the client instead. Do still use \`<form>\` +
\`onSubmit\` — Enter-to-submit accessibility is worth keeping.

### Do-nots

- No CSS frameworks or component libraries — the kit plus small custom CSS
  is the whole styling story (the CSP blocks external scripts/styles/fonts
  anyway).
- Never hardcode a palette: no hex/rgb literals, every color through a
  \`--color-*\` var.
- No decorative motion; don't re-animate what the kit animates.
- Don't hide scrollbars — visible scrollbars are part of the host's feel.

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

Apps run in a sandboxed iframe with an opaque origin, and the host shims
web storage: \`localStorage\` works and PERSISTS — it is saved per
(app, user) by the host and survives reloads and reopens, within a small
quota (512 keys / 256KB; writes beyond it are dropped). Use it freely for
app-local state: this user's items, drafts, view preferences.
\`sessionStorage\` is memory-only, gone when the app closes. State that
other users, agents, or workflows must see does NOT belong in storage —
define a workflow and call it through the app contract.

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
- \`triggers: [trigger("kind", config)]\` subscribes the definition to a host
  trigger kind. Kind names and config/payload types come from the generated
  \`catamorphic-triggers.d.ts\`; config must be an inline constant, and the
  kind's payload type must satisfy the first boundary's input.

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
   The same applies to \`triggers\`: an inline array of direct
   \`trigger("literal-kind", { constant: "config" })\` calls.
10. Workflow definitions and their boundaries use the same JSDoc metadata
    as \`"use step"\` functions. Put \`@displayname\`,
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
- \`Trigger N delivers a payload the first workflow step does not accept\`
  means the kind's payload type is not assignable to the first boundary's
  annotated input. Align the input with the payload in
  \`catamorphic-triggers.d.ts\`; never cast.
- If \`trigger("...")\` rejects every kind name (\`not assignable to
  parameter of type 'never'\`), no \`catamorphic-triggers.d.ts\` augmentation
  is present — the host has not registered trigger kinds or has not synced
  the generated types. Do not fabricate the file or the interface.

Fix errors from the earliest boundary first because one incorrect return type
can cascade through every later tuple element. Run the project's TypeScript
check after each fix and remove temporary error suppressions.
`,
  ...scaffoldSupportFiles(),
};

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: "orders-dashboard",
    name: "Orders Dashboard",
    description: "An app showing open orders, backed by workflows",
    defaultWorkflow: "listOpenOrders",
    files: {
      ...workspaceFiles({
        name: "orders-dashboard",
        dependencies: {
          "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
        },
      }),
      ...SEED_SKILLS,
      ...appScaffold({ name: "dashboard" }),
      "contracts/src/index.ts": `import type { Workflow } from "@catamorphic/app";

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
  listOpenOrders: Workflow<ListOpenOrders>;
  markOrderShipped: Workflow<MarkOrderShipped>;
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
      "workflows/src/orders.ts": `import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";
import type { Order } from "@project/contracts";

/**
 * @displayname List Open Orders
 * @description Fetch open orders for the dashboard
 * @param limit - @displayname Max Orders | @description Maximum number to return
 */
export const listOpenOrders = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ limit?: number }>) => {
        const orders = await fetchOpenOrders({
          limit: clampLimit({ limit: input.limit }),
        });
        return { orders };
      },
    }),
  ],
}));

/**
 * @displayname Mark Order Shipped
 * @description Mark one order as shipped
 * @param orderId - @displayname Order ID | @description The order to ship
 */
export const markOrderShipped = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ orderId: string }>) => {
        // App-callable workflows receive untrusted input: validate before acting.
        if (!/^ord_[a-z0-9]+$/.test(input.orderId)) {
          throw new Error("Invalid order id");
        }
        await shipOrder({ orderId: input.orderId });
        return { shipped: true };
      },
    }),
  ],
}));

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
import {
  Button,
  Card,
  DataTable,
  ErrorState,
  useAsync,
} from "@catamorphic/app/ui";
import { useState } from "react";

const workflows = createClient<AppContract>();

export function App() {
  const [reloadKey, setReloadKey] = useState(0);
  const [shipping, setShipping] = useState<string | null>(null);
  const orders = useAsync(
    () => workflows.listOpenOrders.call({ limit: 20 }),
    [reloadKey],
  );

  if (orders.status === "error") return <ErrorState onRetry={orders.retry} />;

  const ship = async (orderId: string) => {
    setShipping(orderId);
    try {
      await workflows.markOrderShipped.call({ orderId });
      setReloadKey((key) => key + 1);
    } finally {
      setShipping(null);
    }
  };

  return (
    <Card title="Open orders" description="Orders waiting to ship">
      <DataTable<Order>
        columns={[
          { key: "id", header: "Order" },
          { key: "customer", header: "Customer", sortable: true },
          {
            key: "total",
            header: "Total",
            align: "right",
            sortable: true,
            render: (order) => \`$\${order.total}\`,
          },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (order) => (
              <Button
                size="sm"
                loading={shipping === order.id}
                loadingLabel="Shipping…"
                onClick={() => void ship(order.id)}
              >
                Ship
              </Button>
            ),
          },
        ]}
        rows={orders.status === "ok" ? orders.value.orders : []}
        rowKey={(order) => order.id}
        loading={orders.status === "loading"}
        empty="No open orders."
      />
    </Card>
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
      ...workspaceFiles({
        name: "welcome-user",
        dependencies: {
          "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
        },
      }),
      ...SEED_SKILLS,
      "workflows/src/welcome.ts": `import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";

/**
 * @displayname Welcome New User
 * @description Onboard a new user with welcome email and follow-up
 * @param email - @displayname Email Address | @description The user's primary email
 * @param name - @displayname Full Name | @description The user's display name
 */
export const welcomeUser = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: BoundaryContext<{ email: string; name: string }>) => {
        const user = await createUser({
          email: input.email,
          name: input.name,
        });
        await sendWelcomeEmail({ to: user.email, name: user.name });

        if (user.plan === "premium") {
          await assignPremiumBenefits({ userId: user.id });
        }

        await sleep("7 days");
        await sendFollowUpEmail({ to: user.email });

        return { status: "complete", userId: user.id };
      },
    }),
  ],
}));

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
      ...workspaceFiles({
        name: "order-processing",
        dependencies: {
          "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
        },
      }),
      ...SEED_SKILLS,
      "workflows/src/process-order.ts": `import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";

/**
 * @displayname Process Order
 * @description Process an e-commerce order end-to-end
 * @param orderId - @displayname Order ID | @description The order to process
 * @param items - @displayname Items | @description Item ids in the order
 * @param customerId - @displayname Customer ID | @description The ordering customer
 */
export const processOrder = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: BoundaryContext<{
        orderId: string;
        items: string[];
        customerId: string;
      }>) => {
        const { orderId, items, customerId } = input;
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
      },
    }),
  ],
}));

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
      ...workspaceFiles({
        name: "data-pipeline",
        dependencies: {
          "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
        },
      }),
      ...SEED_SKILLS,
      "workflows/src/pipeline.ts": `import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";
import { extractFromSource } from "./steps/extract";
import { validateSchema, transformData } from "./steps/transform";
import { loadToDatabase, verifySync } from "./steps/load";
import { acquireLock, releaseLock, sendAlert } from "./steps/infra";

/**
 * @displayname Data Sync Pipeline
 * @description Extract, transform, and load data from multiple sources in parallel
 * @param sources - @displayname Sources | @description Source names to validate
 * @param targetDb - @displayname Target Database | @description Database to sync into
 */
export const dataSyncPipeline = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: BoundaryContext<{ sources: string[]; targetDb: string }>) => {
        const { sources, targetDb } = input;
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
          await sendAlert({
            channel: "slack",
            message: "Transform errors detected",
          });
        }

        await loadToDatabase({ targetDb, batchSize: 1000 });
        await sleep("5 minutes");
        await verifySync({ targetDb, expectedCount: transformed.rowCount });
        await releaseLock({ resource: targetDb });

        return { status: "synced", rows: transformed.rowCount };
      },
    }),
  ],
}));

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
      ...workspaceFiles({
        name: "support-routing",
        dependencies: {
          "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
        },
      }),
      ...SEED_SKILLS,
      "workflows/src/route-ticket.ts": `import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";

/**
 * @displayname Route Support Ticket
 * @description Route incoming support tickets to the right team based on priority level
 * @param ticketId - @displayname Ticket ID | @description The ticket to route
 * @param priority - @displayname Priority | @description Reported priority level
 * @param customerEmail - @displayname Customer Email | @description Where to send the acknowledgment
 */
export const routeSupportTicket = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: BoundaryContext<{
        ticketId: string;
        priority: string;
        customerEmail: string;
      }>) => {
        const ticket = await lookupTicket({ ticketId: input.ticketId });

        if (ticket.priority === "critical") {
          await escalateToManager({
            ticketId: ticket.id,
            reason: "Critical priority",
          });

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

        await sendAcknowledgment({
          to: input.customerEmail,
          ticketId: ticket.id,
        });
        return { status: "routed", ticketId: ticket.id };
      },
    }),
  ],
}));

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
