import { APP_THEME_COLOR_TOKENS } from "@catamorphic/app";
import { PARSER_PACKAGE_VERSION } from "@catamorphic/parser";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import { BATCH_WORKFLOWS_SKILL } from "./batch-workflows-skill.js";
import { DURABLE_WORKFLOWS_SKILL } from "./durable-workflows-skill.js";
import { PROJECT_WORKSPACE_IGNORE } from "./services/project-workspace.js";
import { SESSION_ARTIFACTS_SKILL } from "./session-artifacts-skill.js";
import { SESSION_WORKFLOWS_SKILL } from "./session-workflows-skill.js";
import { WORKFLOW_LIFECYCLE_SKILL } from "./workflow-lifecycle-skill.js";
import { WRITING_WORKFLOWS_SKILL } from "./writing-workflows-skill.js";

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
      "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
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
  ".catamorphic/package.json": rootWorkspacePkg(name),
  ".catamorphic/.gitignore": PROJECT_WORKSPACE_IGNORE,
  [PROJECT_CHECK_SCRIPT_PATH]: PROJECT_CHECK_SCRIPT,
  ".catamorphic/contracts/package.json": contractsPkg,
  ".catamorphic/contracts/tsconfig.json": SHARED_TSCONFIG,
  ".catamorphic/contracts/src/index.ts": CONTRACTS_INDEX,
  ".catamorphic/workflows/package.json": workflowsPkg(dependencies),
  ".catamorphic/workflows/tsconfig.json": SHARED_TSCONFIG,
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
 * Scaffold for one app under `.catamorphic/apps/<name>/`. Vite builds in IIFE lib mode to
 * exactly one `dist/app.js` + one `dist/app.css`; everything imported (react
 * included) is bundled in, which is what lets the host render the bundle in a
 * credential-less sandboxed iframe.
 */
export const appScaffold = ({
  name,
}: {
  name: string;
}): Record<string, string> => ({
  [`.catamorphic/apps/${name}/package.json`]: appPkg(name),
  [`.catamorphic/apps/${name}/tsconfig.json`]: APP_TSCONFIG,
  [`.catamorphic/apps/${name}/vite.config.ts`]: APP_VITE_CONFIG,
  [`.catamorphic/apps/${name}/src/main.tsx`]: APP_MAIN_TSX,
});

export const APP_PACKAGE_VERSION = "0.0.3";

/** Where the seeded project check script lives; owned by the project. */
export const PROJECT_CHECK_SCRIPT_PATH = ".catamorphic/scripts/check.ts";

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
 * just the how-to-run-it. (Missing the dependency? \`bun install --cwd .catamorphic\`,
 * or \`bun add --cwd .catamorphic -d @catamorphic/parser\`.)
 *
 * Usage:
 *   bun run --cwd .catamorphic check                # validate (exit 1 on errors) — CI-friendly
 *   bun run --cwd .catamorphic check -- --write     # also (re)write generated app-api types
 *   bun run --cwd .catamorphic check -- --host URL  # validate trigger bindings against a
 *                                # running Catamorphic host (GET /api/trigger-kinds)
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkProject, type CheckTriggerKind } from "@catamorphic/parser";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "app-data"]);

async function collectFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(full);
        continue;
      }
      const relative = ".catamorphic/" + path.relative(root, full).split(path.sep).join("/");
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
      const target = path.resolve(process.cwd(), "..", relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
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
  ".catamorphic/skills/batch-workflows/SKILL.md";
export const DURABLE_WORKFLOW_SKILL_PATH =
  ".catamorphic/skills/durable-workflows/SKILL.md";

const SCAFFOLD_SKILL_DIR = ".catamorphic/skills/catamorphic-projects";
const APPS_SKILL_DIR = ".catamorphic/skills/building-apps";

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
  [`${SCAFFOLD_SKILL_DIR}/files/workflows.package.json`]: workflowsPkg(),
});

/**
 * The per-app scaffold shipped as support files of the `building-apps` seed
 * skill, so an agent creates `.catamorphic/apps/<name>/` by copying files instead of
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
 * project repo under `.catamorphic/skills/<name>/SKILL.md` (Agent Skills spec) so
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
description: What a Catamorphic project can hold, including documents, code, automations, apps, committed agents and roles, and the project store, and how to add the automations/apps workspace to a project that has none. Use when the user asks for their first workflow, automation, or app, asks what this project is, asks about who may see or do what (roles, members, the store, sharing), or wants to configure the project's shared sidebar or starting actions.
---

# Catamorphic projects

A Catamorphic project is a folder that can hold any kind of work — documents, notes, data, plans, code, automations (workflows), and user-facing apps, in any mix. Never assume the project is about code or automations: read what is actually there first.

All Catamorphic capabilities live under \`.catamorphic/\`: its own Bun workspace, apps, workflows, contracts, scripts, agents, roles, skills, and shared settings. Leave existing project files and manifests unchanged. Opening a project or having an ordinary conversation does not create this workspace.

## Persistent project data

Use \`.catamorphic/app-data/<app-or-workflow>/\` for project-owned mutable data. Create \`.catamorphic/.gitignore\` on first use with \`/app-data/\`, \`node_modules/\`, and \`dist/\`; preserve existing ignore choices. Users may deliberately track ordinary data by changing these rules. Catamorphic does not manage database exports or replication. Desktop-wide credentials, chats, profiles and caches stay in host-managed storage.

Workflow execution uses an immutable source snapshot. For persistent local data, use \`process.env.CATAMORPHIC_APP_DATA_DIR\` and a subdirectory for your capability. The local host supplies this location when supported; fail clearly if it is absent rather than silently saving durable data into a temporary deployment. Cloud execution does not automatically sync local app data. Frontend apps call workflows for database/filesystem access.

## App settings versus project content

Preferences such as theme, fonts, keyboard shortcuts, tabs and notifications are
host configuration, not workflow code. Consult the host's offered configuration
skill and tools before editing them. In Catamorphic desktop, use the host skill
\`configuring-catamorphic-desktop\` and the per-turn host configuration context
for exact file paths, schemas and scopes. Edit those files directly when accessible. Other embedders may expose a different contract.
Never assume a sandbox's filesystem is the host's configuration directory.

## Adding automations or apps to a project that has none

Workflows and apps live in a bun workspace: an independent \`.catamorphic/package.json\` with \`"workspaces": ["contracts", "workflows", "apps/*"]\`. If \`.catamorphic/workflows/package.json\` does not exist yet, install the workspace BEFORE writing the first workflow, by copying this skill's support files (in \`files/\` next to this document) into place:

| Copy | To |
|---|---|
| \`files/package.json\` | \`.catamorphic/package.json\` |
| \`files/check.ts\` | \`.catamorphic/scripts/check.ts\` |
| \`files/contracts.package.json\` | \`.catamorphic/contracts/package.json\` |
| \`files/tsconfig.json\` | \`.catamorphic/contracts/tsconfig.json\` AND \`.catamorphic/workflows/tsconfig.json\` |
| \`files/contracts.index.ts\` | \`.catamorphic/contracts/src/index.ts\` |
| \`files/workflows.package.json\` | \`.catamorphic/workflows/package.json\` |

Then:

1. Set \`.catamorphic/package.json\` "name" to the project's name. Leave the imported project's root manifest, dependencies, and instruction files unchanged. Create \`.catamorphic/.gitignore\` with \`/app-data/\`, \`node_modules/\`, and \`dist/\` entries if it does not exist; preserve the user's existing ignore choices.
2. Run \`bun install --cwd .catamorphic\`. Run workspace checks with \`bun run --cwd .catamorphic check\`.
3. Read \`writing-workflows\` before writing workflow code and \`building-apps\` before creating an app under \`.catamorphic/apps/<name>/\`. Use the host's skill listing and reader: imported projects may receive these skills from the host without copies in \`.catamorphic/skills/\`.

Do NOT install the workspace preemptively — only when automations or apps are actually wanted.

## Saving, recording, and sharing files

Call \`documents_storage\` when unsure where an MCP connection saves files.
A desktop-local connection saves to the project folder on that device. A remote
MCP connection saves on that server. Use the desktop-local connection or local
file tools for private drafts. Saving does not mean uploading or committing.

To share selected documents, use the host's sharing tools or UI and check the
destination and audience. A desktop-local draft is not automatically available
on a remote server. Follow the host's conflict and upload contract.
For documents intended as shared project source, save a reviewed copy outside
\`.catamorphic/app-data/\` and explicitly commit it. Owners may instead choose
to track local data by editing ignore rules; that does not change document API
permissions or upload it through store synchronization. Explain the destination
before pushing or sharing.

## The program, the store, and who may reach what

A project has one path namespace with two backings:

- Everything in git is the **program**: docs, code, workflows, apps, and the
  committed \`.catamorphic/agents/\` and \`.catamorphic/roles/\` files below. It changes by commit (and,
  for members without commit rights, by proposal — see below).
- \`store/\` is the **project store**: data made by *using* the brain —
  per-customer notes, contracts, generated decks, uploads. It is versioned
  per write on the server and stamped with who wrote it. Logical document
  addresses use \`store/\`; local backing files live under
  \`.catamorphic/app-data/store/\` and are ignored by default. Never create
  a repository-root \`store/\` directory for these documents. Put audience-specific or fast-changing
  content there, never next to the handbook. Read and write it through the
  documents surface (\`documents_*\` MCP tools, \`context.documents\` in a
  workflow, or the folder itself in the desktop) — not by committing.

Access is enforced by the host from **roles you commit** as
\`.catamorphic/roles/<slug>.json\`, next to \`.catamorphic/agents/<slug>.json\`:

\`\`\`jsonc
// .catamorphic/roles/csm.json
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
// .catamorphic/roles/admin.json
{ "version": 1, "name": "Admin", "builder": true, "documents": ["store/**"] }
// .catamorphic/roles/brain-maintainer.json
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
- Name agents by their file slug (\`.catamorphic/agents/csm-assistant.json\`), workflows by
  their exported name, apps by \`.catamorphic/apps/<name>\`. A role may narrow an agent's
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

## Choose where agents run

The project manifest declares logical Environments; roles grant them and an
agent's \`environment.allowed\` / \`environment.preferred\` policy narrows and
recommends the choices. A machine is usable only when the host has supplied a
compatible, available binding. Do not invent a server id or treat adding a JSON
entry as provisioning a machine.

A remote project keeps one authority for membership, connections, and history.
\`binding: "this-machine"\` offers an authenticated member device when the host
supports client execution. It never requires the member to receive database
credentials. A managed server is enrolled by the host operator. Moving a session
is explicit and resumes its saved checkpoint; never retry an uncertain action
just because a connection returned.

## Shape the project experience from capabilities

In the Catamorphic desktop reference host, a project may ship a shared
\`.catamorphic/sidebar.js\` and up to six New Tab starters in the ordinary
\`.catamorphic/project.json\` manifest. Both may target resolved authority with
\`when: { builder?, permissions? }\`; never branch on a role slug. Every declared
condition must match, invalid conditions fail closed, and omitted configuration
leaves no empty UI behind.

\`\`\`jsonc
// .catamorphic/project.json
{
  "startingActions": [
    {
      "label": "Review onboarding",
      "prompt": "Review our onboarding system and propose improvements.",
      "agent": "brain-maintainer",
      "when": { "permissions": ["brain:maintain"] }
    }
  ]
}
\`\`\`

\`\`\`javascript
// .catamorphic/sidebar.js
module.exports = {
  left: [{ id: "project", title: "Project", icon: "House", sections: [
    { id: "chats", type: "chats" },
    { id: "files", type: "files" },
    {
      id: "brain",
      type: "custom",
      title: "Company brain",
      when: { permissions: ["brain:maintain"] },
      items: [{ label: "Handbook", url: "https://handbook.example.com" }],
    },
    { id: "changes", type: "git", title: "Changes", when: { builder: true } },
  ] }],
  right: [],
};
\`\`\`

These are project-owned presentation files, not a stock-server bootstrap
format and not workflow logic. Embedders may provide a different presentation
contract while using the same resolved permission vocabulary.

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
  ".catamorphic/skills/writing-workflows/SKILL.md": WRITING_WORKFLOWS_SKILL,
  ".catamorphic/skills/building-apps/SKILL.md": `---
name: building-apps
description: The mechanics of building frontend apps that call this project's workflows — workspace shape, bundle contract, the typed app contract and client, storage, sandbox constraints, and the build/verify flow. Use when creating an app, wiring UI to workflows, exposing a workflow to apps, or changing the app contract.
---

# Building Apps

Reuse project-owned components and follow the project's app design guidance first.
When the user, project or host points to a component registry, fetch the appropriate
item and read its source, declared dependencies and usage notes. Discover the components.read capability through discover_capabilities when
available, then invoke it to list or fetch the host's shipped items. Install source into the project,
then adapt it; do not treat registry components as a hidden runtime dependency.
Preserve existing customizations. Temporary apps keep installed pack files in their
explicit artifact snapshot instead of changing the project. For code reviews,
consult session-artifacts and fetch the code-review pack unless suitable components
are already installed. More packs follow the same install-and-adapt process.

Choose a canonical icon at creation, or discover set_app_presentation to change its
type: review, dashboard, report, tracker, form, or calculator. All code reviews
use review. When no type clearly fits, use default (the ordinary grid icon).
The same tool accepts title. Use a short, descriptive title for the app's
purpose or subject, matching the user's language. Keep it stable as you iterate;
avoid generic labels such as Session app or unnecessary status/version suffixes.
There is no required title template. Neither title nor icon changes rebuild or
publish the app. Do not invent custom glyphs or colors for common app types.

Generated interactive results, including code reviews, use ordinary apps.
For a temporary or session-owned result, load the session-artifacts skill and
discover session_artifact when the host provides capability discovery (or use the direct MCP tool). It supplies the same scaffold,
retains source with the session and builds immediately without publication.
The project-file steps below apply when the result belongs in the project.

A project is a bun workspace with three kinds of member:

- \`.catamorphic/contracts/\` — **types only, never runtime code.** The one package both
  sides may depend on.
- \`.catamorphic/workflows/\` — backend code. Only this executes in a sandbox.
- \`.catamorphic/apps/<name>/\` — one React frontend per directory, built by Vite to a
  single \`dist/app.js\` + \`dist/app.css\` and rendered by the host in a
  credential-less sandboxed iframe.

**Apps never import from \`.catamorphic/workflows/\`.** The boundary is structural —
\`.catamorphic/contracts/\` has no JavaScript to bundle — but respect it in your head
too: anything an app imports ships to every viewer's browser.

## Collections and compact host widgets

For hierarchies and large lists, import \`createCollection\` from
\`@catamorphic/app\` and \`CollectionTree\`, \`CollectionItemView\`,
\`useCollection\`, and \`useCollectionItem\` from \`@catamorphic/app/ui\`.
Sources load paged roots and lazy children with stable IDs, cursors and an
AbortSignal. Publish item patches for label/status changes and invalidate only
changed branches. Use per-item subscriptions instead of one timer per row.
Acquire a collection while it is needed and release it on cleanup; shared
collections refcount upstream listeners. Tree row height is explicit and only
the visible window is mounted. Keep large inspectors outside row geometry.
The same ItemAction can appear in inline actions, overflow, or right-click menus;
these placements are independent and an empty menu explicitly disables it.

When a host grants collection capabilities, \`createHostCollection({source})\`
uses the same store and tree. Execute only advertised actions via
\`runCollectionAction({source,itemId,action})\`; never reach into the host DOM,
IPC, or credentials. Read \`subscribeDisplay\` for current surface and visibility,
and call \`reportContentState\` with loading, ready, empty or error so the host
can decide whether the widget is useful. Keep the collection acquired for cheap
availability discovery if the widget should reappear after becoming empty;
pass \`active: false\` to a second tree subscriber to avoid duplicate ownership.
Host-specific source names, grants and placement belong in the host's settings
skill. Read that skill and the installed package declarations before authoring.

## The contract is the whole data path

1. Declare the shape in \`.catamorphic/contracts/src/index.ts\`:

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

2. Implement and expose in \`.catamorphic/workflows/src/app-api.ts\`:

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
  workflow's real signature and \`.catamorphic/workflows/\` fails to typecheck in the
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

Scaffold \`.catamorphic/apps/<name>/\` (kebab-case name) by copying this skill's
support files (in \`files/\` next to this document) into place:

| Copy | To |
|---|---|
| \`files/package.json\` | \`.catamorphic/apps/<name>/package.json\` (set \`"name"\` to \`<name>\`) |
| \`files/tsconfig.json\` | \`.catamorphic/apps/<name>/tsconfig.json\` |
| \`files/vite.config.ts\` | \`.catamorphic/apps/<name>/vite.config.ts\` |
| \`files/main.tsx\` | \`.catamorphic/apps/<name>/src/main.tsx\` |

Then write \`src/app.tsx\` exporting the \`App\` component \`main.tsx\`
mounts, and run \`bun install\` inside \`.catamorphic/\`. When another app
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
- Hosts may mount the same app in a compact sidebar slot. Use responsive layout
  and host theme tokens. \`subscribeDisplay(listener)\` from \`@catamorphic/app\`
  immediately reports \`{ mode: "full" | "compact", visible: boolean }\` and
  subsequent changes; it returns an unsubscribe function. Pause optional polling
  while invisible and resume on visibility. Hidden slots retain the app and its
  drafts. Compact mode changes presentation only, never permissions.
- \`getContext()\` from \`@catamorphic/app\` gives the mount snapshot
  (tenant, user, host extras). Anything richer is one workflow call away.
- Verify with \`bun run build\` in the app directory: it must produce
  \`dist/app.js\` and typecheck clean. Fix contract errors at the source —
  never with \`any\` or \`@ts-ignore\`.
- You build and preview; a human publishes.

Before writing app UI, consult the designing-apps skill for this
workspace's UI standards, when present.
`,
  ".catamorphic/skills/designing-apps/SKILL.md": `---
name: designing-apps
description: How apps should look and feel in this workspace — the @catamorphic/app/ui component kit, host theme tokens, the three data states, and the layout, motion, border, scrolling, overlay and drag-and-drop doctrine. Use when building or styling app UI.
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
| \`Tooltip\` | \`label\`, \`delay\` | Hover/focus hint (~500ms delay — never instant). Portaled; hides on any pointer movement away. Never use the native \`title\` attribute. |
| \`Popover\` | \`anchorRef\`, \`open\`, \`onClose\`, \`align\` | Anchored panel: portaled, flips to fit, closes on outside pointerdown and Esc, grows smoothly when its content loads late. Never hand-roll a floating panel. |
| \`Collapsible\` | \`open\` | Structural show/hide that slides neighbours (grid rows 0fr↔1fr); closed content stays mounted but inert. Never animate \`height\` by hand. |
| \`Tree\` / \`CollectionTree\` | \`items\`/\`collection\`, \`renderItem\`, \`height\`, \`rowHeight\`, \`selectedId\`, \`dragAndDrop\` | Virtualized tree with keyboard navigation, lazy children and the one drag-and-drop model (see below). \`CollectionItemView\` is the standard row. |
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
empty. Wire them with \`useAsync\`. Never write your own "Loading…" text,
spinner or empty sentence: a \`Spinner\` means a read is in flight right
now (never a placeholder for "not loaded yet"), rows stay on screen while
a refresh runs, and empty copy is one faint sentence plus at most one
action.

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

## Surfaces, borders and focus

- **One border, one ring, one radius.** A control, row, tile, card or popover
  is one rounded box. Its focus ring is drawn on that box with that box's
  radius (inside it when neighbours could cover it), never on an unrounded
  child inside it, and never in addition to the box's own border. Nested
  bordered cards, square rings inside rounded controls, and a ring beside a
  border are defects. The kit already does this for every component; keep
  custom surfaces to one bordered box.
- Rows inside a \`Card\` are plain hover rows, not more cards; pickers are
  the only bordered children.
- Check every new surface with keyboard focus (Tab through it) before
  calling it done.

## Scrolling

- The element that scrolls fills its pane edge to edge so the scrollbar sits
  at the pane's edge; centered or max-width content lives *inside* the
  scroller, never around it.
- Every scroller reserves its gutter (\`scrollbar-gutter: stable\`, which the
  kit's \`DataTable\`, \`Dialog\` and \`ScrollHint\` already do) so content
  never shifts when a scrollbar appears.
- Never put a scrolling list inside another scroller: \`Tree\` and
  \`CollectionTree\` scroll themselves; give them a \`height\` instead of
  wrapping them. Containing overscroll on something that cannot scroll traps
  the wheel; the kit's tree contains it only while it can scroll.

## Hover controls and tooltips

- Controls that belong to a hovered row (overflow dots, close, open) are
  hidden until the row is hovered or holds keyboard focus, fade in and out on
  \`--cat-motion-fast\`, and never stay lit after a mouse click. Use
  \`:hover\` and \`:has(:focus-visible)\` on the row, never \`:focus-within\`.
- Tiles too small for hover controls open the same menu on right-click.
- Every icon-only control gets a \`Tooltip\`; never the native \`title\`.

## Overlays

- Dialogs, popovers and tooltips come from the kit and render at the
  document body. A \`position: fixed\` element inside a transformed or
  filtered ancestor positions itself relative to that ancestor: never place
  a fixed panel inside app content.
- A popover or hover card that shows more once data arrives grows with a
  transition; it never shifts layout on load. \`Popover\` does this for you.
- Modals scale and fade in and out together; the exit holds its last frame
  until the backdrop is gone (\`Dialog\` does this). Nothing inside an
  embedded app draws its own close X for the app itself; the host owns
  that chrome.

## Drag and drop

- One model, in \`Tree\`/\`CollectionTree\` via \`dragAndDrop = { drag,
  accept, onDrop }\`: the tree owns pointer math, the accent insertion line
  between rows and the accent outline on the row (or tree) that becomes the
  parent. Rows with children are the only "inside" targets; everything else
  lands before or after a sibling.
- Declare what a row offers when dragged and what a target accepts; never
  write drop-zone markup, payload formats or highlight classes of your own.
  Keep a drop cue visible while dragging so the user knows where release
  lands.

## Reduced motion

- The kit collapses every transition and keyframe to an instant change
  under \`prefers-reduced-motion: reduce\` and nothing loops. Script-driven
  motion (\`element.animate\`) must read the same media query and use a 0
  duration when it matches.

## Do-nots

- No CSS frameworks or component libraries — the kit plus small custom CSS
  is the whole styling story (the sandbox CSP blocks external
  scripts/styles/fonts anyway).
- Never hardcode a palette: no hex/rgb literals, every color through a
  \`--color-*\` var.
- No decorative motion; don't re-animate what the kit animates.
- Don't hide scrollbars — visible scrollbars are part of the host's feel.
`,
  [BATCH_WORKFLOW_SKILL_PATH]: BATCH_WORKFLOWS_SKILL,
  [DURABLE_WORKFLOW_SKILL_PATH]: DURABLE_WORKFLOWS_SKILL,
  ...scaffoldSupportFiles(),
  ...appSupportFiles(),
};

/**
 * Host-tier skills: playbooks the HOST ships, listed alongside a project's
 * own `.catamorphic/skills/` without ever being written into the project repo.
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
  "session-artifacts/SKILL.md": SESSION_ARTIFACTS_SKILL,
  "workflow-lifecycle/SKILL.md": WORKFLOW_LIFECYCLE_SKILL,
  "session-workflows/SKILL.md": SESSION_WORKFLOWS_SKILL,
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

- \`git rev-parse --is-inside-work-tree\` — if this is still a plain folder,
  initialize Git at the project root now that the user wants to publish it.
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

Report the repository URL. Imported repositories use explicit commits and
pushes. Run those actions when the user asks; saving a file locally does
not authorize sharing it.
`,
};
