# Workflow creation during sessions

Audit date: 2026-09-08. The primary agent-facing reference is the host-tier
`workflow-lifecycle` skill in `packages/core/src/workflow-lifecycle-skill.ts`.
It is offered through the existing SkillsService/MCP and desktop skill
materialization paths, including projects with older seeded authoring skills.
Embedders can replace or remove it through `hostSkills`; the standing prompt
remains replaceable through `standingAgentPrompt`.

## Supported paths

| Request | Source | Lifecycle |
| --- | --- | --- |
| Temporary session check | Source passed to the watcher tool, committed on `catamorphic/watchers/<id>` from an isolated origin checkout | Expiring session-owned enablement; stopped by explicit stop, expiry, or session close/archive |
| Reusable project workflow | Exported `defineWorkflow` under `workflows/src/` | Ordinary checkpoint/review/sync, followed separately by deployment and optional enablement |
| Run shared code for one user | Existing reviewed project source | Member-owned enablement with that user's exact connections and consent |
| Save privately for later reuse | Host-provided private artifact capability | The stock desktop's discovery, invocation, and private schedules are not implemented |

The last two rows are different: personal credentials and execution do not
make workflow source private. A watcher ref is temporary execution storage,
not private source storage. An unpushed branch is not a privacy boundary.

## Corrections

- Added a current host-tier lifecycle guide and linked it from the standing
  prompt and seeded authoring skill. It covers file layout, dependency placement,
  tool availability, origin-based watcher imports, consent, terminal cleanup,
  and accurate reporting of saved/shared/deployed/enabled outcomes.
- Fixed a missing `BoundaryContext` import in a shipped trigger example.
- Watcher creation now requires the requested export to come from the supplied
  source. It cannot silently select a similarly named existing project workflow.
- Watchers in projects without a package manifest get a minimal runtime manifest
  on the isolated revision. The user checkout remains unchanged; a regression
  test imports that committed source with its resolved runtime package.
- Reserved personal files no longer enter project discovery, sandbox source
  snapshots, or framework checkpoints. Native git checkouts and linked worktrees
  use the local git exclude file. Already indexed personal files cause checkpoints
  to fail with an actionable error; nothing silently deletes or rewrites history.
- Kept desktop-specific feature availability in the desktop's instructions.
  The framework guide allows an embedder to supply private storage and execution.

## Limits

This change does not implement the deferred private-workflow product in ADR
0068, nor does it make private workflow source available remotely. That needs
an explicit visibility/execution decision and a complete invocation surface.
It also cannot erase private files that someone previously committed or pushed.

Tests cover real git checkpoints, linked worktrees, private file API rejection,
watcher source ownership, and host-skill discovery without rewriting project
skills. Existing deterministic harness tests cover shared prompt/tool delivery;
no real model credentials are needed for this audit.
