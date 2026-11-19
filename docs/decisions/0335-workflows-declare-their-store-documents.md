# 0335 — Workflows declare the store documents they use

- **Status:** Accepted (amends 0158, 0330)
- **Date:** 2026-11-19

## Context

A project automation runs as the project principal: its own workflow, the
project's agents, the consented Environment, connections and permissions,
and no documents. The store is reachable only through document refs (ADRs
0055, 0158), and a workflow could declare permissions but not documents, so
a project automation could never read or write the store. Two ready-made
recipes failed on their first run, turned on as their guides say: a GitHub
poller that keeps its cursor in the store, and a review recipe that keeps
the evidence of a stalled turn there. Their tests used hosts that never
enforce scope.

## Decision

**A workflow declares the store paths its runs read or write. Whoever turns
it on consents to them as to its permissions, and its runs reach those and
nothing else of the store.**

- **Declaring.** `defineWorkflow({ documents: [{ path: "store/polling/",
  access: "write" }] })`. `write` also reads. A path ending in `/` is a
  folder and covers what is under it; any other path is one document. A
  folder never covers a sibling with a longer name (`store/a/` does not
  cover `store/ab`). Only plain `store/` paths: no `..`, `.`, empty
  segments, leading `/`, backslashes, patterns or control characters. Each
  entry is written in place with string literals, as `permissions` is, so
  the paths a person approves are the paths in the source. The parser, and
  so the capability check, refuses anything else and says why.
- **Consent.** The preview lists the documents beside the permissions, and
  the consent digest covers them (only when a workflow declares some, so
  existing digests stand). Turning a workflow on for the project also needs
  the consenting identity to reach every declared path with its access: no
  one hands on what they lack. A member may turn on for themselves a
  workflow that declares more than they reach; its runs get the overlap.
- **Following (amends 0330).** The enablement keeps the consented list. A
  published revision moves a follower only when every path it declares is
  covered by a consented one (same document, or under a consented folder,
  with at least its access) and the authority digest is unchanged. A new
  path, or read becoming write, waits for consent like a new permission; a
  narrower declaration follows, and the enablement then keeps the narrower
  list, so widening it again asks again. The documents stay out of the
  authority digest itself so that narrowing can be told from widening.
- **Running (amends 0158).** A run of an enablement holds, of its owner's
  store refs, only the declared paths (or the parts of them its owner
  reaches), with write only where both give it. The project principal of a
  project automation holds exactly the consented paths. A member's own
  automation holds the overlap of the declaration and what the member
  reaches now, checked again at every run. A child run holds what its
  parent run holds of the child's own declaration, as with permissions.
  Program paths and every other ref are untouched. A run started directly
  by a person or an app (no enablement) keeps its caller's store refs, as
  before (ADR 0055).
- **Nothing inherits them.** A project chat a run delivers into runs as the
  project principal without documents; a member's chat runs as that member;
  their subsessions run as the chat's owner; workflows started by events a
  run records run as their own enablements.

Alternatives: give project automations the whole store (every automation a
store administrator); a role file for the project principal (consent
belongs to whoever turns each workflow on); keep documents in the authority
digest (a narrower declaration would stop following like any change);
computed paths (a person could not see what they approve).

## Consequences

Recipes that keep state in the store declare it and run as project
automations, with no member stand-in. Turning such a workflow on for the
project needs someone who reaches those paths. Follow-up: whether runs
started directly by a member or an app should be narrowed the same way.
