# 0035 — App entity, build pipeline, and bundle storage

- **Status:** Accepted
- **Date:** 2026-07-27
- **Expands:** 0001 (code is the source of truth), 0013 (test and production modes), 0032 (workspace layout)

## Context

ADR 0032 gave projects an `apps/*` workspace, but nothing could build, store, or
version the result. A user-built UI needs a compiled bundle, a preview/publish
lifecycle, and somewhere to keep the bytes — without violating the rule that
tables never define what exists in the repo.

## Decision

**The repo defines which apps exist; the database anchors what was built.**
`AppsService.list` scans `apps/<name>/package.json` in the checkout. The `apps`
row is created lazily on first build, and `app_versions` is an append-only build
history: `kind IN ('preview', 'published')`, `status IN ('building', 'ready',
'failed')`, at most one `is_active` published version per app (partial unique
index). Versions are never mutated in place — opencx's draft-overwrite model
made "did my rebuild land?" unanswerable by version id, and append-only rows
avoid that class of bug outright.

**Builds run in the caller's existing dev sandbox — no new sandbox type.** The
`chk_sandbox_type` constraint stays `('execution', 'dev')`. Previews compile
the user's mutable dev tree in place, mirroring ADR 0013's test mode. Published
builds materialize the pinned commit into a scratch directory
(`<workspaceRoot>/app-builds/<sha>`), build there, and remove it — the artifact
is reproducible from git alone, mirroring production mode. Vite (IIFE lib mode)
emits exactly one `app.js` + one `app.css`, everything bundled in.

**Bundles live in a host-injected `AppBundleStore`** (structural subset of
`@catamorphic/s3`'s `ObjectStore`), keyed
`apps/<tenant>/<project>/<app>/<version>/`. Per ADR 0002 the store is
constructor-injected config, never a hard-wired backend. Published bundles are
permanent; preview versions are pruned beyond a small count, bundles included.

A failed build is a recorded outcome (`status='failed'` + compiler output), not
an exception — the agent loop needs to read the error and iterate.

`app_versions.allowed_workflows` is reserved for the authorization freeze
(broker ADR, forthcoming); the build pipeline does not populate it yet.

## Consequences

Apps get a full build/preview/publish lifecycle with zero new infrastructure:
no new sandbox type, no new storage service, no registry table. Bundle size is
capped (5 MiB default, host-configurable) at build time.

Publish-time authorization, tenant app policies, and serving the bundle to
non-builder viewers are the next layer (broker ADR). The
`GET .../bundle` route currently requires project access; the viewer audience
arrives with the broker.
