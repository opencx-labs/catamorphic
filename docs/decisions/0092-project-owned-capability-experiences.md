# 0092: Project-owned capability experiences

- **Status:** Accepted
- **Date:** 2026-09-04
- **Refines:** 0055, 0071, 0089

## Context

The member/builder distinction is an execution and checkout fact, not a
complete description of how a project should serve a brain maintainer,
operator, reviewer, or another host-specific role. Hard-coded personas in the
desktop would duplicate committed role policy.

## Decision

Committed role definitions may grant any syntactically valid namespaced
project permission. Catamorphic reserves and enforces the names it documents;
embedders may enforce additional names in their services. Unknown names grant
no Catamorphic authority by themselves, but remain part of resolved identity
and introspection.

Project-authored presentation targets resolved authority rather than role
names. Sidebar sections and custom items, plus New Tab starting actions, may
declare `when: { builder?, permissions? }`. Every declared condition must
match. Missing predicates show normally and invalid predicates fail closed.
This replaces 0089's fixed `member`/`builder` starting-action segments.

## Consequences

Projects can ship a minimal experience for a brain maintainer without teaching
the desktop that persona or weakening artifact, Environment, and connection
scope. Embedders and the stock host consume one identity vocabulary. The
framework must keep its reserved permissions documented and enforced, while
project-defined permissions are meaningful only to presentation or an
embedder that explicitly implements them. The stock server continues to use
its agent-driven project provisioning flow; ongoing configuration uses the
normal reviewed project change loop.
