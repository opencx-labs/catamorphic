import { APP_THEME_COLOR_TOKENS } from "@catamorphic/app";
import { PARSER_PACKAGE_VERSION } from "@catamorphic/parser";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";

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
 * The canonical workspace scaffold. A project is a bun workspace so one repo
 * holds backend workflows and frontend apps, with `contracts` as the only
 * package both sides depend on. Projects don't get it at creation (ADR 0043 —
 * the workspace appears on demand, installed by agents via the
 * `catamorphic-projects` seed skill, whose support files are generated from
 * these same constants).
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

const appPkg = (name: string) =>
  JSON.stringify(
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
  );

const APP_TSCONFIG = `{
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
}`;

const APP_VITE_CONFIG = `import react from "@vitejs/plugin-react";
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
`;

const APP_MAIN_TSX = `import { createRoot } from "react-dom/client";
import { App } from "./app.js";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
`;

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
  [`apps/${name}/package.json`]: appPkg(name),
  [`apps/${name}/tsconfig.json`]: APP_TSCONFIG,
  [`apps/${name}/vite.config.ts`]: APP_VITE_CONFIG,
  [`apps/${name}/src/main.tsx`]: APP_MAIN_TSX,
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
const APPS_SKILL_DIR = ".agents/skills/building-apps";

/**
 * The workspace scaffold shipped as support files of the
 * `catamorphic-projects` seed skill, so an agent can install the workspace
 * into a project that has none by copying files instead of reconstructing
 * them from memory. Generated from the same constants as `workspaceFiles` —
 * the two cannot drift.
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
 * The per-app scaffold shipped as support files of the `building-apps` seed
 * skill, so an agent creates `apps/<name>/` by copying files instead of
 * reconstructing the vite/tsconfig contract from memory. Generated from the
 * same constants as `appScaffold` — the two cannot drift.
 */
const appSupportFiles = (): Record<string, string> => ({
  [`${APPS_SKILL_DIR}/files/package.json`]: appPkg("my-app"),
  [`${APPS_SKILL_DIR}/files/tsconfig.json`]: APP_TSCONFIG,
  [`${APPS_SKILL_DIR}/files/vite.config.ts`]: APP_VITE_CONFIG,
  [`${APPS_SKILL_DIR}/files/main.tsx`]: APP_MAIN_TSX,
});

/**
 * Per-project agent skills seeded into every project. Skills live in the
 * project repo under `.agents/skills/<name>/SKILL.md` (Agent Skills spec) so
 * they are versioned with the code, scoped per project, and read by coding
 * agents from the dev sandbox checkout. The workflow skills are reference
 * material — consulted only when workflow work happens; seeding them does
 * not make a project a workflow codebase (ADR 0043).
 *
 * These are the framework DEFAULTS: an embedder replaces, extends, or removes
 * them through `CatamorphicCoreConfig.projectSeeds` (ADR 0049).
 *
 * There are no project templates: these skills (and their copyable support
 * files) are how agents build anything from a blank project (ADR 0051).
 *
 * The split matters: `building-apps` is MECHANICS (framework contracts every
 * embedder needs); `designing-apps` is DOCTRINE (how apps should look and
 * feel in the workspace) — the seed an embedder most legitimately swaps for
 * its own.
 */
export const SEED_SKILLS: Record<string, string> = {
  [`${SCAFFOLD_SKILL_DIR}/SKILL.md`]: `---
name: catamorphic-projects
description: What a Catamorphic project can hold — documents, code, automations, apps, committed agents and roles, the project store — and how to add the automations/apps workspace to a project that has none. Use when the user asks for their first workflow, automation, or app, asks what this project is, or asks about who may see or do what (roles, members, the store, sharing).
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

## The program, the store, and who may reach what

A project has one path namespace with two backings:

- Everything in git is the **program**: docs, code, workflows, apps, and the
  committed \`agents/\` and \`roles/\` files below. It changes by commit (and,
  for members without commit rights, by proposal — see below).
- \`store/\` is the **project store**: data made by *using* the brain —
  per-customer notes, contracts, generated decks, uploads. It is versioned
  per write on the server, stamped with who wrote it, and NEVER committed to
  git (\`store/\` is gitignored). Put audience-specific or fast-changing
  content there, never next to the handbook. Read and write it through the
  documents surface (\`documents_*\` MCP tools, \`context.documents\` in a
  workflow, or the folder itself in the desktop) — not by committing.

Access is enforced by the host from **roles you commit** as
\`roles/<slug>.json\`, next to \`agents/<slug>.json\`:

\`\`\`jsonc
// roles/csm.json
{
  "version": 1,
  "name": "CSM",
  "description": "Customer success: their own customers, the handbook, the CSM assistant.",
  "agents": ["csm-assistant"],                 // or { "name": "…", "toolPolicies": { "slack": { "default": "ask" } } }
  "workflows": ["crm.lookup", "docs.search"],
  "environments": ["local"],
  "connections": ["gmail"],
  "apps": ["customer-tracker"],
  "documents": [
    "docs/**",                                                       // read the handbook
    { "path": "store/customers/{customer}/**", "access": "write" }   // their customers only
  ]
}
// roles/admin.json
{ "version": 1, "name": "Admin", "builder": true, "documents": ["store/**"] }
// roles/brain-maintainer.json
{ "version": 1, "name": "Brain Maintainer", "permissions": ["brain:maintain"], "agents": ["brain-maintainer"] }
\`\`\`

Rules of thumb when authoring roles:

- \`{param}\` placeholders are filled from each member's grants (the host
  says "alice: customer = acme, globex"); an entry whose placeholder is not
  granted yields nothing — never a wildcard.
- \`"builder": true\` = may edit the program (files, deploys, secrets,
  agents). It does NOT grant the store: even admins see only the
  \`documents\` their role lists. Leave \`store/**\` off an admin role that
  must not read every customer's data.
- Name agents by their file slug (\`agents/csm-assistant.json\`), workflows by
  their exported name, apps by \`apps/<name>\`. A role may narrow an agent's
  tools with \`toolPolicies\` (allow / ask / deny per tool, per connector
  server key, or \`catamorphic\` for the project's own workflow tools).
- \`permissions\` is an extensible namespaced capability list. Catamorphic
  enforces its documented names (\`memberships:manage\` and \`roles:manage\`);
  hosts may enforce their own names, such as \`brain:maintain\`. A custom
  permission does not grant framework authority unless the host implements it.
  The desktop may use these capabilities in project-authored \`when\` rules.
- A member sees a workflow only when a role grants its exported name. An
  unattended workflow also needs role grants for its chosen Environment and
  every declared connection alias. Grant the project agent too when the
  workflow wakes that agent.
- Keep roles few and readable; membership (who has which role and grants)
  is the host's, not a file here.

Workflow code declares provider-neutral requirements in its top-level
\`connections\` array. Roles decide who may use those aliases; the host decides
which concrete providers satisfy them. Each member opens **Automate**, chooses
**Enable for me**, reviews the pinned revision, Environment, actions, and
triggers, then authenticates anything missing. When the member initiated that
flow, the host may finish enabling automatically after the final required
connection succeeds. Merely connecting an account never opts the member into
every eligible workflow.

Two more things members do without commit rights:

- **Propose a change** to the program (\`propose_change\` tool /
  \`POST /projects/:id/proposals\`): the files land on a branch authored as
  the member and, when the project is on GitHub, as a pull request on their
  behalf. Use it for handbook fixes and new templates when you cannot commit.
- **Publish** a store document (\`POST /projects/:id/publications\`, audience
  \`members\` or \`public\`): a stable URL for a deck or a report; revoke by
  slug. Publish only what the requester owns.

For searching documents, read the host skill \`searching-documents\` first
(primitives — list, read, grep, full text — before building an index).
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
  workflows; add more boundaries for explicit retry policies, pauses, child
  workflow calls, or host calls (\`context.documents.*\`,
  \`context.host.<capability>.<fn>()\`), or brokered provider calls
  (\`context.connections.<alias>.<action>()\`; see \`durable-workflows\`).
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

Schedules use the built-in provider-neutral trigger kind:

\`\`\`typescript
trigger("schedule", { cron: "0 8 * * 1-5", timezone: "Asia/Amman" })
\`\`\`

The schedule is inert until a member enables the workflow. It then runs as
that member with the exact Environment and connections they reviewed.

## Required connections and agent notifications

Declare every account an unattended workflow needs, even when a woken agent
rather than a direct workflow step will use it. Aliases are provider-neutral;
an authenticated MCP server is sufficient when it supplies the required
actions.

\`\`\`typescript
type SchedulePayload = {
  bindingId: string;
  scheduledFor: string;
  firedAt: string;
};

export const inboxSummary = defineWorkflow(({ defineBoundary }) => ({
  connections: [
    { alias: "gmail", principal: "member", capabilities: ["search", "read"] },
  ],
  triggers: [
    trigger("schedule", { cron: "0 8 * * 1-5", timezone: "Asia/Amman" }),
  ],
  steps: [
    defineBoundary({
      run: async ({ input, host }: BoundaryContext<SchedulePayload>) =>
        host["catamorphic.sessions"].wake({
          key: "daily-inbox-summary",
          agentSlug: "inbox-assistant",
          title: "Daily inbox summary",
          content:
            "Review my Gmail inbox since the previous summary. Summarize what matters, call out anything urgent, and include useful links.",
          notification: {
            title: "Your inbox summary is ready",
            body: "Open the chat to review it.",
          },
        }),
    }),
  ],
}));
\`\`\`

\`wake\` creates or reuses one member-owned session for the stable \`key\`
scoped to this workflow, queues the agent turn, and returns immediately. When
the turn settles, desktop and PWA show a pulsing attention dot and push can
deep-link to the same conversation. Opening it acknowledges the attention.
The role must grant the workflow, \`inbox-assistant\`, its Environment, and
\`gmail\`. Service-owned enablements cannot call \`wake\`; use an explicit
member enablement for personal notifications. Use \`deliver\` instead when a
workflow already has the exact session id.

## Temporary watchers

When the project MCP surface offers \`create_github_watcher\`, use it for
session-scoped monitoring instead of adding permanent trigger configuration.
The tool accepts ordinary TypeScript source exporting one \`defineWorkflow\`.
Declare subscriptions in that workflow with the same inline \`trigger()\`
calls as any committed workflow. The boundary input is the normalized Project
Event envelope; inspect \`input.kind\` and \`input.payload\`, then optionally
deliver to a session:

\`\`\`typescript
return context.host["catamorphic.sessions"].deliver({
  sessionId: "the session to notify or wake",
  content: "Checks failed on PR #42. Investigate and repair them.",
  mode: "next_turn", // message_only | next_turn | interrupt
  idempotencyKey: \`checks-failed:\${input.id}\`,
});
\`\`\`

\`message_only\` records context without starting a turn. \`next_turn\` wakes
an idle session or queues behind its active turn. Use \`interrupt\` only when
letting the current turn finish would make the result wrong. Watcher source is
pinned on an isolated git ref and expires automatically; it is never merged
into the project's main branch.

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
description: The mechanics of building frontend apps that call this project's workflows — workspace shape, bundle contract, the typed app contract and client, storage, sandbox constraints, and the build/verify flow. Use when creating an app, wiring UI to workflows, exposing a workflow to apps, or changing the app contract.
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

## Forms

A native \`<form>\` submit REALLY NAVIGATES the sandboxed app frame: the
sandbox allows forms, and the CSP's \`form-action\` does not inherit from
\`default-src\`, so nothing blocks it — the app reloads from scratch and
loses all state (verified; Enter in any input triggers it via implicit
submission). **Always \`event.preventDefault()\` in \`onSubmit\`** and call
workflows through the client instead. Do still use \`<form>\` +
\`onSubmit\` — Enter-to-submit accessibility is worth keeping.

## Creating an app

Scaffold \`apps/<name>/\` (kebab-case name) by copying this skill's
support files (in \`files/\` next to this document) into place:

| Copy | To |
|---|---|
| \`files/package.json\` | \`apps/<name>/package.json\` (set \`"name"\` to \`<name>\`) |
| \`files/tsconfig.json\` | \`apps/<name>/tsconfig.json\` |
| \`files/vite.config.ts\` | \`apps/<name>/vite.config.ts\` |
| \`files/main.tsx\` | \`apps/<name>/src/main.tsx\` |

Then write \`src/app.tsx\` exporting the \`App\` component \`main.tsx\`
mounts, and run \`bun install\` at the workspace root. When another app
already exists in the workspace, prefer copying its config so
project-local changes carry over.

The vite config MUST include
\`define: { "process.env.NODE_ENV": JSON.stringify("production") }\` —
lib mode does not inject it, and a bundle that still references
\`process.env\` at runtime ships dev-mode React (bigger and slower; the
host shims \`process\` so it runs, but never rely on that).

Apps run in a sandboxed iframe with an opaque origin under a strict CSP:
external scripts, styles, and fonts are blocked, so everything the app
uses must be bundled or written in the app itself. The host shims
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

Before writing app UI, consult the designing-apps skill for this
workspace's UI standards, when present.
`,
  ".agents/skills/designing-apps/SKILL.md": `---
name: designing-apps
description: How apps should look and feel in this workspace — the @catamorphic/app/ui component kit, host theme tokens, the three data states, and the layout and motion doctrine. Use when building or styling app UI.
---

# Designing Apps

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

## Component inventory

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
| \`AnimatedList\` | \`items\`, \`getKey\`, \`renderItem\`, \`itemClassName\` | Keyed list whose rows animate in when added and collapse out BEFORE removal — use it for any list that gains/loses items. |
| \`useAsync(load, deps)\` | returns \`{status:"loading"} \\| {status:"error",error,retry} \\| {status:"ok",value}\` | Load workflow data into the three states below. |

## The three data states

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

## Layout doctrine

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

## Motion doctrine

The kit animates itself — dialogs, popovers, tooltips, spinners already
follow the host's motion contract — and hands apps the same contract for
their own structure:

- List content that gains/loses items renders through \`AnimatedList\`:
  added rows animate in, removed rows animate OUT before unmount, on the
  host's pacing. Never splice a visible list without it.
- Other structural appear/disappear takes the kit's utility classes:
  \`cat-anim-enter\`/\`cat-anim-exit\` (fade + slight rise and its mirror),
  or \`cat-row-enter\`/\`cat-row-exit\` on hand-rolled one-line rows (adds
  the height collapse so neighbors slide into place). The exit classes hold
  their final frame (\`forwards\`) — remove the element on \`animationend\`,
  never before.
- Hover feedback is a color transition on
  \`var(--cat-motion-fast) var(--ease-standard)\`.

Everything rides the host's tokens — \`--cat-motion-fast/base/slow\` and
the one easing \`--ease-standard\`; never hardcode a duration or curve.
Exits mirror enters, slightly quicker. Nothing loops, nothing bounces,
nothing animates on load.

## Do-nots

- No CSS frameworks or component libraries — the kit plus small custom CSS
  is the whole styling story (the sandbox CSP blocks external
  scripts/styles/fonts anyway).
- Never hardcode a palette: no hex/rgb literals, every color through a
  \`--color-*\` var.
- No decorative motion; don't re-animate what the kit animates.
- Don't hide scrollbars — visible scrollbars are part of the host's feel.
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
it to the exact workflow package version used by the host.
Do not recreate the types locally or bypass the missing API with assertions.

## Capability model

- \`defineWorkflow\` receives a builder callback.
- \`defineBoundary\` is available only on that builder context.
- \`pause\`, \`callWorkflow\`, \`documents\` and \`host\` are available only
  in a boundary's \`BoundaryContext\`; \`caller\` (who triggered the run) is
  there too.
- A boundary is one atomic retry unit. If an attempt fails, all code in that
  boundary runs again. Ordinary \`"use step"\` functions called inside it may
  eventually be visualized, but are not separate persisted checkpoints.
- A returned transition resolves before the next boundary starts. The resolved
  value, not the transition object, is the next boundary's input.
- \`caller\`, \`documents\` and \`host\` are also on \`BoundaryContext\`
  (ADR 0055). \`caller\` is who triggered the run — stamped by the host from
  the verified identity, never from \`input\`; absent when the host ran the
  workflow as itself. \`documents.read/list/search/write/delete/history\`
  and \`host.<capability>.<fn>(args)\` are transitions like
  \`callWorkflow\`: return them from a boundary, receive the result as the
  next boundary's input. They execute on the host AS THE CALLER — a
  workflow can only reach what the caller may — so returning
  \`documents.read({ path })\` for a path the caller lacks fails that step.
  Retrying the step re-runs the call (at-least-once, like any step IO).
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
   Connection requirements are also static: use an inline \`connections\`
   array of alias strings or constant requirement objects. Credential values
   and concrete connection ids never belong in workflow code.
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
  ...appSupportFiles(),
};

/**
 * Host-tier skills: playbooks the HOST ships, listed alongside a project's
 * own `.agents/skills/` without ever being written into the project repo.
 * Keys are paths relative to a host-skills root (`<name>/SKILL.md`), so a
 * host can materialize the set on disk (e.g. as a Claude Code plugin) with
 * the layout intact.
 *
 * These are the framework DEFAULTS: an embedder replaces, extends, or
 * removes them through `CatamorphicCoreConfig.hostSkills` (ADR 0049 — same
 * contract as `projectSeeds`). A project skill with the same name shadows a
 * host skill everywhere.
 */

/**
 * How to search a project's documents (ADR 0055): the core primitives first,
 * a project-owned index only when they run out. Host-tier so every agent
 * building or using a brain reads the same recipe.
 */
const SEARCHING_DOCUMENTS_SKILL = `---
name: searching-documents
title: Search project documents
description: Find things in a project's documents — the program (docs, handbook, code) and the project store (store/…, per-customer notes, contracts, generated files). Use before answering from documents, and when asked to build search or "semantic search" for a project.
---

# Searching project documents

A project is one path namespace: the **program** (git — docs/, the handbook,
workflows, apps; read at the shared main) and the **project store**
(\`store/…\` — data made by using the brain: customer notes, contracts,
generated decks; versioned per write, stamped with who wrote it). What you
can see is exactly what the caller's grants cover: search never returns a
document the caller may not read. Everything below is scope-filtered at the
source, so use it freely.

## Start with the primitives (usually enough)

Over HTTP (the host mounts these at its API prefix), from a workflow
(\`context.documents.*\`, ADR 0055), or from an MCP tool that wraps them:

- **list** — \`GET /projects/:id/documents?prefix=docs\` (or \`prefix=store/customers/acme\`): paths, sizes, versions, authors.
- **read** — \`GET …/documents/content?path=docs/handbook.md\` (JSON with \`text\`), \`…/documents/raw?path=\` for bytes, \`&version=N\` for history.
- **grep** — \`GET …/documents/search?q=refund&prefix=docs\` — case-insensitive literal substring; matching lines with line numbers.
- **full text** — \`…/documents/search?q=renewal acme&mode=text\` — words in any order (Postgres full-text on the store, tokenized match on the program).
- **history** — \`…/documents/history?path=store/customers/acme/notes.md\`.

Method: narrow by prefix, grep for the concrete term, read the few hits.
Prefer several small greps to one broad full-text query; prefer reading a
whole short document over stitching snippets. Cite paths (and versions for
store documents) in answers.

## When to build more (and how)

Add a project-owned index only when the primitives fail on real questions:
paraphrase ("customers unhappy with billing" ≠ "refund"), very large
corpora, or ranking across thousands of documents. Then:

1. **Keep the index in the project's Postgres**, next to the store — never in
   the blob backend. Full-text (\`tsvector\`) plus vectors (\`pgvector\`) in one
   table keyed by \`(path, version)\`; hybrid ranking (BM25/ts_rank + cosine)
   beats either alone. Chunk by headings/paragraphs, keep the path and the
   line range on every chunk so answers can cite.
2. **Embed with the AI SDK** the project already depends on (\`embedMany\`
   from \`ai\` with the host's provider); store the model id with the row and
   re-embed on model change.
3. **Index on write**: a workflow triggered when a store document changes
   (or a periodic sweep) that reads the document through
   \`context.documents.read\` and upserts chunks. Reading through
   \`context.documents\` is what keeps the index honest about scope: the
   indexer only sees what its caller may.
4. **Serve as a workflow tool** (\`ai.tool-call\` trigger kind) that takes
   \`{ query, prefix?, limit? }\`, embeds the query, ranks, and — before
   returning — re-reads each hit through \`context.documents.read\` so a
   caller who cannot read a document never sees its chunk. That final read
   is not optional: the index is a hint, the documents surface is the law.
5. Return the same shape as the primitives (\`path\`, \`source\`, \`lines\`)
   plus a score, so agents can treat it like a smarter grep.

Do not: run embeddings on every request, put document text into a vector
DB outside the project's database, or return chunks without a final
scope-checked read. Do not build this for a brain of a few hundred short
documents — grep is faster and never lies.
`;

export const HOST_SKILLS: Record<string, string> = {
  "searching-documents/SKILL.md": SEARCHING_DOCUMENTS_SKILL,
  "publishing-to-github/SKILL.md": `---
name: publishing-to-github
title: Publish to GitHub
description: Publish a project to GitHub — log the user into GitHub if needed, then push to a new repository or an existing empty one. Use when the user wants a project on GitHub, or wants to push, publish, or share a project that has no GitHub remote yet.
---

# Publishing a project to GitHub

Goal: the project folder pushed to a GitHub repository the user owns, with
\`origin\` configured so later pushes work.

This flow is for projects with NO GitHub remote yet. If \`git remote -v\`
already shows an origin, or the project was imported from GitHub, use the
sync_project / create_pull_request tools instead — and never replace an
existing remote without asking.

Run everything below in a terminal at the project root (run_terminal, or
your own shell if you have one).

## 1. Preflight

- \`git rev-parse --is-inside-work-tree\` — every project is a git
  repository; in the unexpected case this fails, \`git init\` first.
- \`git log --oneline -1\` — if there are no commits yet, create one from
  what's there (\`git add -A && git commit\`); an empty project can get an
  empty initial commit (\`git commit --allow-empty -m "init"\`) so there is
  something to push.
- \`command -v gh\` — the GitHub CLI handles both login and repo creation
  in this flow. If it is missing, ask the user before installing it
  (\`brew install gh\` on macOS).

## 2. Authentication

- \`gh auth status\` — already logged in? Continue.
- If not: tell the user you are starting GitHub login, then run
  \`gh auth login --web --git-protocol https\` in a visible terminal. It
  prints a one-time code and opens the browser; the user finishes there.
  Wait for the command to exit, then re-check \`gh auth status\`.
- Never ask the user to paste tokens or passwords into the chat.

## 3. Confirm before pushing

Pushing is outward-facing. Confirm with the user before creating anything:
the repository name, the owner (personal account or an organization), and
visibility — default to private unless they say otherwise.

## 4. Push

- New repository:
  \`gh repo create <owner>/<name> --private --source=. --remote=origin --push\`
  (swap \`--private\` for \`--public\` if that was the choice).
- Existing empty repository:
  \`git remote add origin <url>\` then \`git push -u origin HEAD\`.
  If the push is rejected because the repository is not actually empty,
  stop and ask — never force-push over someone's existing history.

## 5. Wrap up

Report the repository URL. Note for the user: the app's automatic sync
applies to projects imported from GitHub; this project now pushes and pulls
through its git \`origin\` remote — you can run those pushes for them on
request.
`,
};
