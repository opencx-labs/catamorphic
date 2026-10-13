# 0225 — Session metadata, and a sidebar section for the chat in front

- **Status:** Accepted
- **Date:** 2026-10-13
- **Refines:** [0147](0147-uniform-sidebar-sections.md) (sections), [0132](0132-shared-contextual-sidebar-contributions.md) (contextual relevance), [0215](0215-a-chats-own-worktree.md) (where a chat works)
- **Relates to:** [0219](0219-typed-deliveries.md) (no free-form delivery metadata)

## Context

People want a chat's details beside it: the worktree it works in and the
pull requests it opened or reviews. The worktree is known to the desktop
(0215); pull requests were known to nobody. `create_pull_request` returned a
URL and stored nothing, PRs opened with `gh` or a connector left no trace,
and a review chat on the Work server knew its PR only from its first message.
Recording PRs natively would cover one tool and one forge, and the next
detail (a preview URL, a ticket, a deploy) would need its own field, route
and UI.

## Decision

**Session metadata is one primitive.** A session holds `metadata`, named
JSON values: a field of `SessionFields`, so snapshots, streams, mirrors and
every client read it like the title. Core sets it by key
(`AgentSessionsService.setMetadata`): each key takes its value, null removes
the key, an unchanged value logs nothing. A write is a `session.changed`
event, so a viewer's state follows live; a mirror copies it as it copies the
title, its base included, and a fork starts without it. Whoever may change
the session may set it (the authority of `setActivity`). Agents set it with
`set_session_metadata { key, value }`: a deferred desktop workspace tool
(written a few times in a chat, ADR 0133), the same operation in the project
MCP surface for members' own agents (bound to the calling session), and a
discovered capability for the Work server's agents. People and other clients
use `PATCH …/sessions/:id/metadata`.

**Bounds keep it a few facts, not a store.** Keys are lowercase words joined
by `_`, `-` or `.` (64 characters); at most 32 keys, 16 KB a value and 64 KB
in all, plain JSON nested at most 16 deep (`SESSION_METADATA_LIMITS`,
enforced in core, checked by the route and tools). Larger or private data
belongs in files, the project store or a workflow.

**Conventions are instructions, not code.** `pull_requests` is an array of
`{ url, number?, title?, state? }` (state open, draft, merged, closed). No
tool records it: the desktop-workspace skill, `create_pull_request`,
`publishing-to-github` and the reviewer doctrine tell agents, in a sentence,
to keep it. Readers parse leniently and ignore what does not fit. A person
can teach their agents any other key for sections of their own.

**This session is a section like any other.** The built-in section type
`session` shows the chat in front: its folder or worktree (the words of its
status popup; a click reveals it) and its `pull_requests` (a click opens one
in Work's browser). The default right sidebar leads with a "This session"
tab holding it with `when: { surface: ["chat"], session: true }`, so it
exists only beside a chat. A tab that comes and goes with what is in front is
never the default choice: its arriving never changes the tab shown, and the
person's own choice of it returns with the next chat. Tabs grow into and
shrink out of the strip, the strip opens and folds as the count crosses one,
and the panels cross-fade when the tab in front leaves (200 ms, the
standard curve). Executable sources of a section with `when.session` receive
`session { id, title, metadata }` and load again when it changes.

**Why ADR 0219 does not apply.** 0219 removed free-form `metadata` from
deliveries: facts core and other hosts *act on* (who delivered, causation)
were read by string key from a bag. Session metadata is the opposite: core
never reads a key, nothing authorizes or routes by it, and its only readers
are presentation and the person's own code. A fact core acts on still
becomes a typed field.

Considered: a typed `pullRequests` field with native recording (one forge,
one tool, and a new field for every detail); keys namespaced per agent (a
person's agents share one chat's facts); metadata on the session list rows
(lists stay lean; a list that needs a key reads the session).

## Consequences

Migration 064 adds `agent_sessions.metadata`. Every agent on every harness
can show something beside its chat with one tool call, and a person's agent
can build their own session sections without app code. Nothing guarantees an
agent records its PRs: a model that skips the instruction leaves the section
showing only the folder ("No pull requests yet"). Existing profiles keep
their `workspace.js` until they reset it or add the tab themselves.
