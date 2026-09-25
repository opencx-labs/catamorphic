/** Agent guidance; shipped through the existing skill discovery surfaces. */
export const WRITING_WORKFLOWS_SKILL = `---
name: writing-workflows
description: Write or edit Catamorphic workflow TypeScript, step functions, trigger declarations, connections, and app-facing contracts.
---

# Writing workflows

Every workflow is an exported \`defineWorkflow\` value. Code is the source of
truth; the host derives the visual graph from its TypeScript AST.

Read the existing project layout and generated types first. Use \`workflow-lifecycle\`
for new source placement or enablement, \`session-workflows\` for reminders and
session actions, \`durable-workflows\` for transitions/retries, and \`batch-workflows\`
for persisted paged collections. Load the guidance needed by the task.

## Choose the scope

| Need | Primitive |
| --- | --- |
| Ordinary orchestration over one input | A builder-scoped \`defineBoundary\` with \`"use step"\` helper calls |
| A persisted retry boundary, pause, child call, host or connection operation | Another boundary; return its transition and consume the result in the next boundary |
| A finite paged collection with per-item progress and resumption | Builder-scoped \`defineBatch\` |
| Physically coalesce compatible item calls | Exported \`defineBatchStep\`, called only inside \`defineBatch.process\` |

A small input array can use a loop or \`Promise.all\` inside one boundary. A step
helper is visual detail, not a checkpoint. Failed boundary attempts repeat all
its ordinary IO; make side effects safe to retry. Persistence does not roll back
external calls.

## Authoring shape

Keep definitions at module scope with an inline builder object and \`steps\` array.
Use direct \`defineBoundary\` / \`defineBatch\` entries and inline callbacks. Never
add a workflow kind, a \`stage\` abstraction, or a \`"use workflow"\` directive.
Import from the project's established wrapper, otherwise \`@catamorphic/workflow\`.

\`\`\`typescript
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

/**
 * @displayname Prepare greeting
 * @param name - @displayname Recipient name | @description Person to greet
 */
export const prepareGreeting = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    /** @displayname Format greeting */
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ name: string }>) => {
        const message = await formatGreeting({ name: input.name });
        return { message };
      },
    }),
  ],
}));

/**
 * @displayname Format greeting
 * @param name - @displayname Recipient name | @description Person to greet
 */
async function formatGreeting({ name }: { name: string }) {
  "use step";
  return \`Hello, \${name.trim()}!\`;
}
\`\`\`

Use one destructured object parameter for step helpers and explicit
\`BoundaryContext<Input>\` types for boundary callbacks. A named context parameter
is also supported for returned host calls. Put IO in \`"use step"\` helpers;
keep orchestration readable with calls, conditions, loops, and \`Promise.all\`.
Write each call as its own statement (\`const x = await step(...)\`) or return
it: a call nested inside an object literal or another call's arguments runs but
is not drawn on the canvas.

Add \`@displayname\` to UI-facing workflows, boundaries, steps, and parameter
metadata. Optional \`@description\` and \`@icon\` explain purpose. Place scope JSDoc
immediately above the \`defineBoundary(...)\` or \`defineBatch(...)\` array entry.
Labels describe real behavior: a formatting example must not claim to send mail.

## Triggers and connections

Declare \`triggers: [trigger("literal-kind", { constant: "config" })]\` alongside
\`steps\`. Kind names and config/payload shapes come from the host-generated
\`.catamorphic/workflows/src/catamorphic-triggers.d.ts\`. Config is inline constant data, not an
expression evaluated at runtime. Conditions belong in ordinary workflow code.

The trigger payload is the first scope's input. Multiple triggers require an
input accepting every payload. A generated \`Hole<"Name">\` asks this workflow's
concrete input type to define that part of the schema; do not use \`any\` or
\`unknown\` there. For tool-call triggers this input becomes the tool argument schema.
If every kind is rejected as \`never\`, refresh types through the host rather than
fabricating a registry or editing generated declarations.

Webhooks use \`trigger("webhook", { name: "github" })\`: a lowercase name that
becomes the project's URL segment. The server stores each request durably and
answers 202 before the workflow runs, so a redelivery (same delivery id header) runs
once. The payload's \`payload\` holds \`{ name, headers, contentType, body }\`,
with JSON and form bodies parsed. Add \`verify: { secret: "GITHUB_WEBHOOK_SECRET",
header: "x-hub-signature-256", prefix: "sha256=" }\` for senders that sign with
HMAC-SHA256; the secret is a project secret, and unsigned requests are rejected.
Every workflow on one webhook name must declare the same verify. People who manage
the project copy the URL from the workflow's **Automatic** view after enabling it.
Webhooks reach servers that are online, so enable them on a brain server.

Schedules use either \`{ at: "an absolute ISO timestamp with offset" }\` or
\`{ cron: "0 8 * * 1-5", timezone: "Asia/Amman" }\`. Their payload is
\`{ activationId: string; scheduledFor: string; firedAt: string }\`. Use
\`session-workflows\` for complete executable timer and notification recipes.
Triggers are inert until enabled and enablements pin a revision.

Declare required provider aliases, principal policy, and actions in an inline
\`connections\` array. Roles and the host's enablement flow resolve access and
credentials; see \`workflow-lifecycle\`. Brokered calls such as
\`context.connections.gmail.search(...)\` are returned host transitions, not
ordinary promises. Chats are reached with one operation, \`deliver\`: by \`sessionId\`
for a known chat, or by \`key\` for the chat this workflow keeps for that key,
started on first use (the enabling member's chat, or for a project enablement a
project chat; see \`session-workflows\`). \`mode: "message_only"\` with
\`attention: "required"\` alerts without invoking a model; \`next_turn\` (the
default) has the agent do work.

A run holds no project permission it does not declare. Name the ones it needs
in an inline \`permissions\` array, such as \`permissions: ["sessions:write"]\`
to deliver into other people's chats by \`sessionId\`, or \`["sessions:read"]\`
to list them. Turning the workflow on shows the list, and only someone who
holds every permission can turn it on. A member's automation keeps them only
while that member does; a project automation keeps what was consented to.
Declare the fewest that work; see \`workflow-lifecycle\`.

## App contracts and secrets

Expose only intended workflows from \`.catamorphic/workflows/src/app-api.ts\`; use \`building-apps\`
for the app contract and client. App inputs are untrusted: validate identifiers,
clamp numbers, and bound arrays before acting. Inputs and outputs must survive
JSON: use ISO strings and plain data, not dates, maps, streams, or functions.

App reads intended for \`.call()\` must complete inline. Pauses, retries, rate
limits, batches, and child calls can require asynchronous execution; use
\`.start()\` and the returned handle for that work.

For direct service credentials, declare an inline \`defineSecrets\` object and
read its returned accessor in step helpers. Never hardcode credentials or read
them directly from \`process.env\`. Secret names are SCREAMING_SNAKE_CASE and
cannot start with \`CATAMORPHIC_\`. Configure values through the host; an unset
required secret throws. Secrets stay in backend execution, never app bundles or
returned results. Prefer declared connections for member accounts and brokered access.

The host-provided non-secret \`process.env.CATAMORPHIC_APP_DATA_DIR\` is the location
for persistent local data. Follow \`catamorphic-projects\` for its storage contract.

## Verify the result

Run \`bun run --cwd .catamorphic check\` after structural changes. It checks parsing,
trigger bindings, and app contracts; \`--write\` refreshes generated app types.
Fix the earliest boundary type mismatch instead of adding assertions or ignoring
errors. Check the actual workflow through the host at the intended revision and
exercise relevant success, quiet, failure, and retry paths. Do not invoke paid or
externally mutating integrations just to test them without authorization.

Writing, checking, deploying, and enabling are separate outcomes. Report only
those verified, with the workflow/source/run links the host returns.
`;
