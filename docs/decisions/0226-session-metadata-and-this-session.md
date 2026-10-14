# 0226 — Session metadata, and a sidebar section for the chat in front

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
the session may set it (the authority of `setActivity`), and only on the
host holding the session's authority (or on any host while none does): a
copy elsewhere refuses the write (`AgentSessionAuthorityRequiredError`,
409), since an event logged on a mirror would fork the person's chat at the
next push, and so does the holder while the session moves to another host
(`AgentSessionHandoffPendingError`, 409 `handoff_pending`, as for messages),
since its log was pushed before the move. The same now holds for
`setActivity`. Closed and archived sessions still take writes: a pull
request merges after its chat is done. Agents set it with
`set_session_metadata { key, value }`, remove a key with
`{ key, remove: true }`, and read it with neither (a key's value is replaced
whole, so a list is read before it is written again). The tool refuses a
null value instead of taking it as a removal: a model that fills an unused
parameter with null meant to read. It is a deferred desktop workspace tool (written a
few times in a chat, ADR 0133), the same operation in the project MCP
surface, offered only on a session's own connection and bound to it, and a
discovered capability for the Work server's agents. People and other clients
read it from the session's fields and write it with
`PATCH …/sessions/:id/metadata`, a JSON merge patch (null removes a key).
A sidebar section on screen follows its session live (its stream, or a poll
past the stream limit), so a change made outside any turn shows while a page
the chat opened is in front.

**Bounds keep it a few facts, not a store.** Keys are lowercase words joined
by `_`, `-` or `.` (64 characters); at most 32 keys, 16 KB a value and 64 KB
in all, plain JSON nested at most 16 deep (`SESSION_METADATA_LIMITS`,
enforced in core, checked by the route and tools, and on what a mirror's base
and events bring). The count and total bind writes that grow the object, so
an object over them can always shrink. Larger or private data belongs in
files, the project store or a workflow.

**Conventions are instructions, not code.** `pull_requests` is an array of
`{ url, number?, title?, state? }` (state open, draft, merged, closed). The
shape, its one-sentence description (`SESSION_PULL_REQUESTS_CONTRACT`), the
tool's description and input, and the lenient reader (`sessionPullRequests`)
live in `@catamorphic/agent-protocol`, so every tool and skill quotes one
contract. No tool records it: the desktop-workspace skill,
`create_pull_request`, `publishing-to-github` and the reviewer doctrine (which
records its pull request when it starts and its state when it posts) tell
agents to keep it. Readers ignore what does not fit. A person can teach their
agents any other key for sections of their own.

**This session is a section like any other.** The built-in section type
`session` shows the chat in front: its folder or worktree (the words of its
status popup; a click reveals it) and its `pull_requests` (a click opens one
in Work's browser, as a link in the chat opens: in a tab the chat owns). The
default right sidebar leads with a "This session" tab holding it with
`when: { session: true }`. The sidebar's surface carries the session of the
chat in front, or of the chat that opened the page, file or terminal in
front, so the tab (like the chat's Changes and other session-scoped
sections) stays while the person looks at what the chat opened, and a click
on a pull request never takes it away. A connected project's chat is read in
the project's own access, where its stream keeps it current. A tab that comes
and goes with what is in front is never the default choice: its arriving
never changes the tab shown, and the person's own choice of it returns with
the next chat. Its place grows into and shrinks out of the strip on one
reversible transition, the strip opens and folds as the count crosses one
(never on load or the sidebar's own opening), and the panels cross-fade when
the tab in front leaves (200 ms, the standard curve). Executable sources of a
section with `when.session` receive `session { id, title, metadata }`, load
again when it changes (when shown), and are not searched by the palette,
which has no chat.

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
their `workspace.js` until they reset it or add the tab themselves. Desktop
and server ship together: the session protocol is 2
(`SESSION_PROTOCOL_VERSION`, reported by `GET /me`), so a client of the
other version asks to update Work, and a desktop from before this change
pushing mirrors to an updated server is refused (its snapshot lacks
`metadata`).
