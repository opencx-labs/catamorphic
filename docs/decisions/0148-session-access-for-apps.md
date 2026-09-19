# 0148: Session access for apps

- **Status:** Accepted
- **Date:** 2026-09-19
- **Builds on:** 0036 (app authorization), 0041 (generated projections),
  0053 (identity scope), 0062 (session privacy), 0102 (app widgets and
  collection grants), 0134 (consent binding)

## Context

Workflows can already list, inspect and read the transcript of chat sessions
through the typed `catamorphic.sessions` host operations, and an app can
call any workflow its project exports in `app-api.ts`. The two never met:
a workflow invoked from an app runs as the app-narrowed identity (ADR 0053),
whose scope holds one `app` ref and therefore covers no agent. Every session
operation answered with an empty list or an access error, so an agent asked
to build a "what did I work on this week" app for the user had no honest
path to the data.

Sidebar widgets showed the shape of a fix: a host-granted `collections`
list lets a widget read session metadata, explicitly, per widget. That
grant is desktop-specific and carries no transcript.

## Decision

An app declares the host data it reads in its `package.json`, under
`catamorphic.access`:

```json
{ "name": "activity", "catamorphic": { "access": { "sessions": "read" } } }
```

The declaration is frozen into every built version next to the callable
workflow set, from the same snapshot of the tree. `AppVersion.access` and
`AppSummary.access` expose it; a version built without the declaration
never gains it later.

When a viewer opens such a version, `identityForApp` widens the narrowed
identity with one new artifact ref, `{ kind: "sessions", projectId }`. The
ref means: the caller's own sessions in this project, on every agent of it.
Session access (`assertAgentSessionAccess`) and session listing honor it,
and still require the session owner to be the caller. A viewer of a
published app therefore sees only their own conversations with the project's
agents; the desktop user sees their own chats in their own project. The ref
grants nothing else: no files, no other workflows, no other users.

Apps still reach sessions only through workflows. A workflow exported in
`app-api.ts` calls `context.host["catamorphic.sessions"].list`, `.inspect`
or `.history` and returns the plain JSON the app needs. `SessionSnapshot`
now carries `createdAt`, `updatedAt`, `archivedAt` and `icon`, and history
messages carry `createdAt`, so summaries over time need no second call.

Hosts ask before opening a build that reads the viewer's data. The desktop
records approval per project and app in profile preferences and shows the
request in place of the app until the person allows it; a published app's
publication is the builder's approval, as it is for the workflow set.

## Consequences

- One vocabulary: session access is an artifact ref like any other, so
  narrowing, structural equality and the `/me` summary need no special case
  beyond the new kind.
- The declaration lives in the app's own package, where an agent already
  writes the app's name and dependencies, and `building-apps` teaches the
  three lines it takes: declare, export a workflow, call it.
- Consent is per version content, not per app name: a rebuilt version that
  drops the declaration loses the ref immediately.
- The `sessions` ref is read-oriented by intent, but it also covers the
  session actions a viewer may take on their own conversations (archive,
  interrupt). Widening it to other users' sessions or to transcripts of
  other agents' conversations is out of scope and would need a new ref.
