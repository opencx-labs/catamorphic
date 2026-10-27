# 0261: Customize the Work server with your own image

- **Status:** Superseded by [0287](0287-work-server-deployments-compose-libraries-and-workflows.md) (stock image removed; config remains typed data and hooks remain code)
- **Date:** 2026-10-19

## Context

The stock server took everything through environment variables and three
JSON files (`WORK_GATEWAY_CONFIG`, `WORK_MACHINES_CONFIG`,
`WORK_AUTH_CONFIG`), and every new need tempted a new field: ADR 0256 gave
model connections a declarative `override` and `paths` so the stock image
could pin OpenRouter's providers. Fields like these grow into a small policy
language: the first "only for this model" or "per project" turns them into
a DSL that is harder to write than the few lines of code it imitates, and
that a company's own server never needed. Companies ask their agents to set
up Work servers, and agents write code more easily and more correctly than
they learn a configuration format.

## Decision

**The stock server is one file.** `apps/server/src/index.ts` imports only
packages: it reads its config from the environment, calls `createWorkServer`
with an empty `hooks`, listens, answers mDNS, and shuts down.
`@catamorphic/work-server` exports everything that file and a company's
version of it need: the guard and rewrite types, the connection provider
definers, `ConnectionActionRefusedError`, and the mDNS helpers.

**Anything more is code in your own image.** Guards, model request rewrites,
connection providers, a machine provisioner for another cloud, directories,
seeds and routes are hooks: copy the stock file, fill in `hooks`, and build
on the published image (`FROM` it, `COPY` the file under `apps/server/`,
`CMD` it). Workers keep the published image; hooks run on the control
plane. The setup skill sends agents this way whenever the stock server is
not enough, and tells them not to look for a variable or file field that
does the same.

**The stock configuration does not grow.** It keeps what a deployment must
say (where it listens, its public URL, its database and secrets, its
machines and connections). A need that takes logic or policy is a hook, not
a field. ADR 0256's `override` and model `paths` leave the gateway file,
which refuses them so a file written for them fails instead of pinning
nothing; `override` leaves `defineModelConnectionProvider` too, and
`hooks.modelRequestRewrites` is the one way a model request changes.
`paths` stays a provider option in code.

Considered: a hooks module the stock image loads from a mounted file (a
second way to extend the server, with an image's trust and none of its
review), and keeping declarative fields for the common cases (they grow).

## Consequences

Pinning an aggregator's providers, reviewing actions, or provisioning
machines on another cloud means building and pushing an image of a few
lines and rebuilding it with each release, recopying the stock file when it
changed. Existing variables and files stay; when one of them starts to need
logic, it moves into code rather than growing.
