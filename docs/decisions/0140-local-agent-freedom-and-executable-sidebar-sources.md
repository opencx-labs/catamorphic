# 0140: Local agent freedom and executable sidebar sources

- **Status:** Accepted
- **Date:** 2026-09-17
- **Refines:** 0056, 0111, 0112, 0132

## Context

Local agents could edit project files but default restrictions blocked profile
configuration and added computer-use consent. Static sidebar configuration could
not directly populate a todo list from a file or an HTTP service.

## Decision

Desktop-owned local agents default to full access. Explicit restricted modes,
remote authority, harness restrictions and OS permissions remain authoritative.
Agents edit the real configuration files supplied in their per-turn context.
Definition consent hashes distinguish an omitted mode from an explicit mode,
because the host owns the default. Native Codex attachment support is exposed
consistently in the desktop composer.
The desktop accepts native computer-use app consent for full-access agents;
other forms, URLs and explicit restricted modes retain the existing consent flow.
This supersedes the desktop default of edit in ADR 0056 and the additional
per-app desktop consent default in ADR 0112, not their explicit policy controls.

Sidebar custom sources may point to ordinary TypeScript modules exposing the
existing collection load/subscription contract plus row actions. Modules execute
in lazy Bun subprocesses with ordinary filesystem, network and dependency access.
This refines ADR 0132's no-ambient-authority rule for local executable sources;
renderer code and static layout evaluation remain separate from execution.
Processes are a reliability boundary, not a filesystem sandbox. Remote/member
surfaces keep their existing host-authorized app and collection model.

The existing native tree and item primitives render source results. Stable IDs,
pagination, cancellation, shared subscriptions and visibility leases bound work.
Loading, refresh, empty, failed reads and failed actions are distinct. Refresh
retains existing rows, arrivals use existing list motion, and reduced motion is
respected. Files and HTTP APIs use the same source contract, without a todo DSL.

## Consequences

Local sidebar code has the authority of other local project code. A section can
read files, call APIs and write on interaction without generated snapshots or a
workflow deployment. Inactive sources release listeners and eventually processes;
slow or broken source code cannot block Electron. Library defaults and remote
execution policy are not broadened by desktop defaults.
