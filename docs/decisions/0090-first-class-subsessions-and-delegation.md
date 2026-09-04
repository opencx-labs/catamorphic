# 0090: First-class subsessions and explicit delegation grants

- **Status:** Accepted
- **Date:** 2026-09-04
- **Builds on:** 0038, 0050, 0054, 0056, 0067, 0074, and 0087

## Context

Harness-private subagents are transient provider events. They cannot be
reliably opened, messaged, interrupted, mirrored, searched, or governed like
Catamorphic sessions. Fork ancestry also overloaded the only session-parent
field, while the desktop kept archive state in local preferences without
stopping work.

Agents need to delegate to intentionally different agents. A read-only
designer may be allowed to request implementation from a builder, so child
authority cannot always be a subset of the source agent's own tools. At the
same time, a source must not manufacture credentials or capabilities the user
did not grant.

## Decision

A subsession is an ordinary agent session with an immediate parent. The agent
assigned to it is the subagent. Session hierarchy, transcript fork lineage,
and delegation records are separate. Catamorphic owns every child id,
transcript, lifecycle, and policy even when a harness can use a native
subagent execution path.

Agent definitions carry delegation routes and a per-session concurrent-child
limit, defaulting to ten. A route names an exact target agent or a constrained
same-agent template, plus whether that child may delegate onward. The target
agent's own model, operating mode, connections, skills, tool policy, and
Environment constraints remain its capability boundary. A route selecting an
exact target is explicit authority to ask a more capable specialist to act;
a wildcard route cannot cross the source agent's privilege tier.

Agents use the ordinary project-session list, transcript-read, and
session-message tools for both relatives and peers. Subsession-only tools are
limited to lifecycle operations that have no ordinary equivalent: spawn,
list/wait for completion, interrupt, and request user attention. Children get
a fresh focused context by default, an explicit parent identity, and ordinary
session tools. Full transcript inheritance is opt-in.

Session presentation is durable per user: latent children appear only on the
parent's chip rail; promoted children also appear recursively beneath the
parent in the sidebar; archived sessions are hidden from normal navigation but
remain agent-visible and palette-searchable. User interaction or an explicit
attention request promotes a latent child. Archive is recursive: it stops the
session tree's active work and host-owned processes without closing the
sessions. Archiving asks for confirmation only when that operation would
interrupt live work.

## Consequences

- Harness-native delegation is an adapter optimization, never separate product
  state. Harnesses that cannot preserve the contract use injected capabilities.
- A user can route expensive planning to cheap workers or let a restricted
  coordinator invoke a privileged specialist without giving the coordinator
  those tools directly.
- Archive, stop, close, presentation, and fork have distinct meanings.
- Session lists and clients must carry hierarchy, lineage, delegation,
  presentation, and archive-impact information.
- Archive recursively interrupts live turns, cancels queued work, stops
  Watchers and host-owned processes, disposes provider anchors, and revokes
  active connection grants. It does not close the sessions: unarchiving makes
  them navigable again, and a later message re-anchors the selected agent.
- Recursive navigation and lifecycle operations require cycle defenses,
  concurrency checks, audit metadata, and paired enter/exit motion.
