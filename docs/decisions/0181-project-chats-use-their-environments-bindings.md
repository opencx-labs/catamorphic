# 0181 — Project chats use their Environment's bindings; session events carry keys

- **Status:** Accepted
- **Date:** 2026-09-27
- **Refines:** 0156, 0171, 0172, 0173, 0179

## Context

A pull request review automation (#118) runs its workflows in the project's
default Environment and hands each pull request to a project chat placed in a
`review` Environment on a dedicated pool (ADR 0173). The chat's agent needs
that Environment's GitHub, replica, and Slack bindings, but a project chat
carried the connection scope of the automation that delivered to it: exactly
the aliases consented for the automation's own Environment. So a chat placed
elsewhere was refused every binding of the Environment it actually ran in,
including the Git binding its workspace is seeded with (ADR 0178).

Separately, session events (ADR 0138, 0139) did not name the chat's key, so a
workflow reacting to settled turns ran for every chat in the project and
filtered in code (the Slack reply recipe, ADR 0179), and `where` (ADR 0171)
could only compare whole values, not select a key namespace.

## Decision

**A project chat uses its Environment's committed service bindings.** The
bindings in `.work/project.json` are reviewed configuration (ADR 0172), and a
project chat is the project's own work. So a chat whose owner is the project
principal, running in Environment X, may use X's bindings whose principal is
`service` or `either`, resolved to service connections only, never a member's:
its admission is unattended. Which aliases it holds is still what its agent
definition names, narrowed by the binding's capabilities. Member chats keep
today's rules (role connection grants). The delivering automation's consented
connections remain the automation's own and are no longer copied to its chats.

Reaching a project chat already needs a project enablement or
`automations:write` (ADR 0156), the agent definition that names the aliases is
program reviewed like the bindings, and placement already lets a project chat
use any Environment the project declares (ADR 0173), so no new permission
guards this.

Considered: listing the chat's Environments and aliases in the delivering
workflow for consent. It would duplicate the agent definition's `environment`
and `connections` in a second reviewed file that drifts from them, which ADR
0173 already declined for Environments.

**Session events carry the key.** Every `session.*` event's
`payload.session.key` is the chat's key, or null (migration 034 replaces the
publishing trigger function in place). A closed chat keeps its key, so its
closing events carry it too.

**`where` gains `{ $prefix }`.** A leaf `{ $prefix: "slack:" }` matches a
string that starts with it; anything else (a number, null, absent) does not
match. `Where<T>` offers it only where the payload holds a string. The Slack
reply recipe now binds `session.turn-changed` with
`where: { payload: { session: { key: { $prefix: "slack:" } } } }`. Operators
are `$`-prefixed keys (ADR 0171), so payload fields named `prefix` or
`exists` still match by value.

**The review automation is project code.** The host skill
`reviewing-pull-requests` carries the complete automation (GitHub trigger
library, `review` Environment and image, `reviewer` agent and doctrine, and the
review, answer, and close workflows) as files a team commits under `.work/`;
the setup guide covers the server side. It needs no framework code of its own.

## Consequences

- A delivered chat seeds its workspace at a ref with its own Environment's Git
  binding, and its agent reaches that Environment's service connections, on
  any pool the project opens to it.
- An organization that wants a service connection out of project chats leaves
  it out of the Environment's bindings or the agent definition; guards still
  review every action (ADR 0162).
- Workflows select families of keyed chats declaratively; unrelated chats'
  turns start no runs.
- A payload field literally named `prefix` holding a string cannot be matched
  as an object; match its parent's other fields, as with `exists`.
