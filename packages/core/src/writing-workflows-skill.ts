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
      run: async ({ input }: BoundaryContext<{ name: string }>) => ({
        message: await formatGreeting({ name: input.name }),
      }),
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

Add \`@displayname\` to UI-facing workflows, boundaries, steps, and parameter
metadata. Optional \`@description\` and \`@icon\` explain purpose. Place scope JSDoc
immediately above the \`defineBoundary(...)\` or \`defineBatch(...)\` array entry.
Labels describe real behavior: a formatting example must not claim to send mail.

## Triggers and connections

Declare \`triggers: [trigger("literal-kind", { constant: "config" })]\` alongside
\`steps\`. Kind names and config/payload shapes come from the host-generated
\`workflows/src/catamorphic-triggers.d.ts\`. Config is inline constant data, not an
expression evaluated at runtime. Conditions belong in ordinary workflow code.

The trigger payload is the first scope's input. Multiple triggers require an
input accepting every payload. A generated \`Hole<"Name">\` asks this workflow's
concrete input type to define that part of the schema; do not use \`any\` or
\`unknown\` there. For tool-call triggers this input becomes the tool argument schema.
If every kind is rejected as \`never\`, refresh types through the host rather than
fabricating a registry or editing generated declarations.

Schedules use either \`{ at: "an absolute ISO timestamp with offset" }\` or
\`{ cron: "0 8 * * 1-5", timezone: "Asia/Amman" }\`. Their payload is
\`{ activationId: string; scheduledFor: string; firedAt: string }\`. Use
\`session-workflows\` for complete executable timer and notification recipes.
Triggers are inert until enabled and enablements pin a revision.

Declare required provider aliases, principal policy, and actions in an inline
\`connections\` array. Roles and the host's enablement flow resolve access and
credentials; see \`workflow-lifecycle\`. Brokered calls such as
\`context.connections.gmail.search(...)\` are returned host transitions, not
ordinary promises. Session notifications use \`deliver\` with \`attention: "required"\`;
\`mode: "message_only"\` alerts without invoking a model. Use \`wake\` when a workflow
needs a stable member session to perform agent work, not just display a reminder.

## App contracts and secrets

Expose only intended workflows from \`workflows/src/app-api.ts\`; use \`building-apps\`
for the app contract and client. App inputs are untrusted: validate identifiers,
clamp numbers, and bound arrays before acting. Inputs and outputs must survive
JSON: use ISO strings and plain data, not dates, maps, streams, or functions.

App reads intended for \`.call()\` must complete inline. Pauses, retries, rate
limits, batches, and child calls can require asynchronous execution; use
\`.start()\` and the returned handle for that work.

For direct service credentials, declare an inline \`defineSecrets\` object and
read its returned accessor in step helpers. Never hardcode values or read
\`process.env\` directly. Names are SCREAMING_SNAKE_CASE and cannot start with
\`CATAMORPHIC_\`. Configure values through the host; an unset required secret
throws. Secrets stay in backend execution, never app bundles or returned results.
Prefer declared connections for member accounts and brokered access.

## Verify the result

Run the project's \`bun run check\` after structural changes. It checks parsing,
trigger bindings, and app contracts; \`--write\` refreshes generated app types.
Fix the earliest boundary type mismatch instead of adding assertions or ignoring
errors. Check the actual workflow through the host at the intended revision and
exercise relevant success, quiet, failure, and retry paths. Do not invoke paid or
externally mutating integrations just to test them without authorization.

Writing, checking, deploying, and enabling are separate outcomes. Report only
those verified, with the workflow/source/run links the host returns.
`;
