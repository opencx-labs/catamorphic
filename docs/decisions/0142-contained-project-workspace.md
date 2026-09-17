# 0142: A contained project workspace and local app data

- **Status:** Accepted
- **Date:** 2026-09-17
- **Supersedes:** 0032 (workspace location), 0010 (skill location), 0050 (agent location)
- **Refines:** 0043, 0104, 0141

## Context

Catamorphic capabilities must coexist with arbitrary existing repositories without
adding package manifests, generated tooling, or capability directories to their
roots. Project-owned persistent data should remain beside the project and be
excluded from Git by default. Import and ordinary agent work must remain inert.

## Decision

The sole Catamorphic workspace is `.catamorphic/`. Its Bun package manifest,
lockfile, contracts, workflows, apps, scripts, skills, agent definitions, and
shared project configuration live beneath that directory. Source remains ordinary
TypeScript. Discovery and dependency installation use this boundary rather than
interpreting an imported application's manifests or source as framework code.
There is no root-layout fallback or automatic relocation of existing user files.
Create the workspace only when a capability needs it. Existing repository agent
instructions are honored without injecting root instruction files.

Project-owned mutable data lives under `.catamorphic/app-data/`. A scoped
`.catamorphic/.gitignore` ignores app-data, installed dependencies, and build
outputs by default. Users may deliberately track ordinary data by editing their
ignore rules. Personal artifact privacy remains independently enforced. Document
API addresses retain their existing `store/` namespace and map to the contained
local data directory. Desktop-wide credentials, profiles, chats, caches, and
transient execution/build staging, and managed worktrees remain in host-managed
storage.

Deployment runtimes materialize only the verified capability snapshot, avoiding a
second clone of the imported repository and its unrelated files. Local execution
exposes the project's persistent data location without changing immutable deployed
source. Hosts retain control of storage and execution backends;
cloud execution does not imply synchronization of local app data. Database export,
restore, and replication are out of scope.

## Consequences

A large imported repository retains its original package ecosystem and files.
Catamorphic capabilities and their dependencies form one independently installable,
versioned workspace. The layout is a deliberate alpha breaking change, documented
for authors and tested through discovery, build, execution, and desktop workflows.
