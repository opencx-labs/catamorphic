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
\`steps\`, with \`trigger\` imported from \`@catamorphic/workflow\` (it is not a
builder argument). Kind names and config/payload shapes come from the host-generated
\`.work/workflows/src/work-triggers.d.ts\`: the host's kinds and the project's own
(see Project trigger kinds). Config is inline constant data, not an expression
evaluated at runtime. Which events start a run belongs in \`where\`; what a run
does with one belongs in ordinary workflow code.

The trigger payload is the first scope's input. Multiple triggers require an
input accepting every payload. A generated \`Hole<"Name">\` asks this workflow's
concrete input type to define that part of the schema; do not use \`any\` or
\`unknown\` there. For tool-call triggers this input becomes the tool argument schema.
If every kind is rejected as \`never\`, refresh types through the host rather than
fabricating a registry or editing generated declarations.

Every binding may add \`where\`, a filter the host checks before a run starts:
\`trigger("schedule", { cron: "0 8 * * 1-5", timezone: "UTC", where: { ... } })\`.
It mirrors the payload; a leaf is a value (equal), a list of values (one of),
or \`{ exists: true | false }\`. Header names match in any case. Filter in
\`where\` rather than in code, so unrelated events never start runs.

Webhooks use \`trigger("webhook", { name: "github" })\`: a lowercase name that
becomes the project's URL segment. The server stores each request durably and
answers 202 before the workflow runs, so a redelivery (same delivery id header) runs
once. The payload's \`payload\` holds \`{ name, headers, query, contentType, body }\`,
with JSON and form bodies parsed. The config declares how the endpoint checks
senders, always with a project secret's name:

- \`verify: { scheme: "hmac", secret, header, prefix?, encoding?: "hex" | "base64",
  algorithm?: "sha1" | "sha256" | "sha512", content?, timestamp?, pattern?,
  secretEncoding?, secretPrefix? }\` signs \`content\` (default \`"{body}"\`; also
  \`{timestamp}\` and \`{header:<name>}\`). \`timestamp: { header, pattern?,
  toleranceSeconds? }\` rejects replays (default 300 seconds). \`pattern\` is a
  regex whose capture group finds each signature in a composite header
  (Stripe \`"v1=([0-9a-f]+)"\`, Standard Webhooks \`"v1,([A-Za-z0-9+/=]+)"\`).
  Standard Webhooks keys use \`secretEncoding: "base64", secretPrefix: "whsec_"\`.
- \`verify: { scheme: "token", secret, header | query, prefix? }\` compares a
  shared token (GitLab's \`x-gitlab-token\`); the token is never stored.
- \`respond: [{ when, echo, token? }]\` answers a handshake with 200 and the
  echoed value instead of starting runs: \`{ when: { body: { type:
  "url_verification" } }, echo: "body.challenge" }\` for Slack, or for GET
  subscriptions \`{ when: { method: "GET", query: { "hub.mode": "subscribe" } },
  echo: "query.hub.challenge", token: { secret, query: "hub.verify_token" } }\`.
  A rule without \`token\` answers only requests that pass \`verify\`.
- \`maxBodyBytes\` raises the 1 MiB body limit up to the server's maximum.

Every binding of one webhook name must declare identical settings, so declare
an integration's webhook once, in a project trigger kind. People who manage the
project copy the URL from the workflow's **Automatic** view after enabling it.
Webhooks reach servers that are online, so enable them on a brain server.

Schedules use either \`{ at: "an absolute ISO timestamp with offset" }\` or
\`{ cron: "0 8 * * 1-5", timezone: "Asia/Amman" }\`. Their payload is
\`{ activationId: string; scheduledFor: string; firedAt: string }\`. Use
\`session-workflows\` for complete executable timer and notification recipes.
Event triggers (schedules, webhooks, session and GitHub events) are inert
until enabled, and enablements pin a revision. An \`ai.tool-call\` trigger
needs no enablement: once deployed, the workflow is a tool on the project MCP
for every caller whose role grants it, and it runs as that caller.

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

## Project trigger kinds

A project names the events it cares about in \`.work/triggers/<name>.ts\`: each
export is \`defineTrigger({ name, description?, from: trigger(...), where? })\`,
another kind narrowed by a filter. Workflows bind it by name like a host kind,
with their own \`where\` on top; every filter along the chain must match. Write
\`name\` and \`from\` literally (no variables) and pick names the host does not
already register. A type argument states the payload the filtered events carry;
\`Narrow<Base, Patch>\` types part of it, such as a webhook's body. The host
regenerates \`work-triggers.d.ts\` with these kinds; \`bun run --cwd .work check\`
checks them. \`.work/package.json\` needs \`@catamorphic/workflow\` in
\`devDependencies\` so these files type-check.

A GitHub library, for a repository webhook sending JSON to the project's
\`github\` URL with the secret stored as \`GITHUB_WEBHOOK_SECRET\`:

\`\`\`typescript
// .work/triggers/github.ts
import { defineTrigger, type Narrow, type TriggerPayload, trigger } from "@catamorphic/workflow";

type Delivery<Body> = Narrow<TriggerPayload<"webhook">, { payload: { body: Body } }>;

export interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: { title: string; html_url: string; merged: boolean; draft: boolean };
  repository: { full_name: string };
}

export interface IssueCommentEvent {
  action: string;
  issue: { number: number; title: string; html_url: string; pull_request?: { url: string } };
  comment: { body: string; html_url: string; user: { login: string } };
}

/** Every signed delivery from the repository's webhook. */
export const delivery = defineTrigger({
  name: "gh.delivery",
  description: "Any delivery from the GitHub webhook",
  from: trigger("webhook", {
    name: "github",
    verify: { scheme: "hmac", secret: "GITHUB_WEBHOOK_SECRET", header: "x-hub-signature-256", prefix: "sha256=" },
  }),
});

export const pullRequest = defineTrigger<Delivery<PullRequestEvent>>({
  name: "gh.pull_request",
  description: "A pull request was opened, updated, or closed",
  from: trigger("gh.delivery"),
  where: { payload: { headers: { "x-github-event": "pull_request" } } },
});

export const issueComment = defineTrigger<Delivery<IssueCommentEvent>>({
  name: "gh.issue_comment",
  description: "Someone commented on an issue or pull request",
  from: trigger("gh.delivery"),
  where: { payload: { headers: { "x-github-event": "issue_comment" }, body: { action: "created" } } },
});
\`\`\`

A Slack library for an Events API app whose Request URL is the project's
\`slack\` URL, signing secret stored as \`SLACK_SIGNING_SECRET\`. The \`respond\`
rule answers Slack's URL verification when the URL is saved:

\`\`\`typescript
// .work/triggers/slack.ts
import { defineTrigger, type Narrow, type TriggerPayload, trigger } from "@catamorphic/workflow";

export interface SlackEventCallback {
  type: "event_callback";
  team_id: string;
  event_id: string;
  event: { type: string; user?: string; text?: string; channel?: string; ts?: string; thread_ts?: string };
}

export const slackEvent = defineTrigger<
  Narrow<TriggerPayload<"webhook">, { payload: { body: SlackEventCallback } }>
>({
  name: "slack.event",
  description: "An event from the Slack app",
  from: trigger("webhook", {
    name: "slack",
    verify: {
      scheme: "hmac",
      secret: "SLACK_SIGNING_SECRET",
      header: "x-slack-signature",
      prefix: "v0=",
      content: "v0:{timestamp}:{body}",
      timestamp: { header: "x-slack-request-timestamp", toleranceSeconds: 300 },
    },
    respond: [{ when: { body: { type: "url_verification" } }, echo: "body.challenge" }],
  }),
  where: { payload: { body: { type: "event_callback" } } },
});
\`\`\`

A workflow that runs only for merged pull requests:

\`\`\`typescript
import { type BoundaryContext, defineWorkflow, type TriggerPayload, trigger } from "@catamorphic/workflow";

/**
 * @displayname Summarize a merged pull request
 * @param title - @displayname Title | @description The pull request's title
 * @param url - @displayname Link | @description Where the pull request lives
 */
async function summarizeMerge({ title, url }: { title: string; url: string }) {
  "use step";
  return \`Merged: \${title} (\${url})\`;
}

/** @displayname Note merged pull requests */
export const noteMergedPullRequests = defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("gh.pull_request", {
      where: { payload: { body: { action: "closed", pull_request: { merged: true } } } },
    }),
  ],
  steps: [
    /** @displayname Summarize */
    defineBoundary({
      run: async ({ input }: BoundaryContext<TriggerPayload<"gh.pull_request">>) => {
        const pull = input.payload.body.pull_request;
        return { summary: await summarizeMerge({ title: pull.title, url: pull.html_url }) };
      },
    }),
  ],
}));
\`\`\`

## App contracts and secrets

Expose only intended workflows from \`.work/workflows/src/app-api.ts\`; use \`building-apps\`
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

The host-provided non-secret \`process.env.WORK_APP_DATA_DIR\` is the location
for persistent local data. Follow \`catamorphic-projects\` for its storage contract.

## Verify the result

Run \`bun run --cwd .work check\` after structural changes. It checks parsing,
trigger bindings, and app contracts; \`--write\` refreshes generated app types.
Fix the earliest boundary type mismatch instead of adding assertions or ignoring
errors. Check the actual workflow through the host at the intended revision and
exercise relevant success, quiet, failure, and retry paths. Do not invoke paid or
externally mutating integrations just to test them without authorization.

Writing, checking, deploying, and enabling are separate outcomes. Report only
those verified, with the workflow/source/run links the host returns.
`;
