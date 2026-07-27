# 0032 — Projects are bun workspaces holding workflows, contracts, and apps

- **Status:** Accepted
- **Date:** 2026-07-27
- **Expands:** 0001 (code is the source of truth for workflows and apps)

## Context

Embedders can let their users build workflows with AI but not UIs. Apps must be
part of the same project as the workflows they call: one repo, one commit, so a
frontend and the backend it depends on can never drift apart. That is the
property opencx's mini-apps lack — their published bundles compile against a
backend that keeps moving, and a renamed field breaks a published app at runtime
with no signal on the app side.

A flat project (one `package.json`, one `src/`) cannot express this. Frontend
dependencies would enter the execution sandbox, app sources would be scanned for
workflows, and — because the deployment artifact digest hashes every file in the
repo — editing a `.tsx` file would invalidate the artifact and force a new
sandbox, a reinstall, and a cold supervisor for every workflow.

## Decision

A project is a bun workspace with three kinds of member:

```
package.json          # { "workspaces": ["contracts", "workflows", "apps/*"] }
contracts/            # types only — no runtime code, ever
workflows/            # backend workflows; the only code that executes in a sandbox
apps/<name>/          # frontend apps
```

`contracts` is the only package both sides may depend on, and it must never
contain runtime code. A types-only package has no JavaScript for a bundler to
pull in, so workflow logic — and everything it transitively imports — cannot
reach a browser bundle. This is a structural guarantee rather than a lint rule
or a bundle-graph assertion, and it is why the shared-types package was chosen
over apps importing workflow types directly. The alternative required a
`tsc --emitDeclarationOnly` step purely to strip runtime code, which this
deletes.

App sources never reach execution. `executionFiles()` drops `apps/**` before
parsing, before the execution transform, and before the artifact digest is
computed, so app edits leave the workflow artifact untouched. The parser also
excludes `apps/**` when discovering workflows and step functions: step functions
are collected into one flat name-keyed map, so an app-side function sharing a
name with a step would otherwise override it in both the rendered graph and the
execution transform.

The workflow package declaration moves to `workflows/package.json`. Callers that
resolve it fall back to the repo root so a flat project still works.

## Consequences

Frontend dependencies stay out of the execution sandbox and app edits no longer
invalidate the execution artifact. Backend code cannot leak into a browser
bundle by construction. Workflow discovery is unambiguous.

The artifact digest still includes the commit SHA, so an app-only commit
produces a new artifact identity even though its file set is unchanged; the
digest and file set are now correct, but decoupling artifact identity from
commit provenance is separate work under ADR 0014.

Bun workspaces share one root `bun.lock`, so changing an app's dependencies
still changes the lockfile the execution artifact reads. This is accepted:
it is correctness-safe, and app dependency changes are rare.

Authors declare a shape in `contracts/` and implement it in `workflows/`. A
single `satisfies` on the app-facing surface keeps the two from drifting without
duplicating annotations per function.
