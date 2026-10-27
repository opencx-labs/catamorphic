# 0287: Work server deployments compose libraries and workflows

- **Status:** Accepted (supersedes 0261; amends the image distribution portions of 0059, 0159, 0160 and 0285)
- **Date:** 2026-10-28

## Context

An audit of workflow-driven code reviews treated missing native AWS support
and empty stock server hooks as product blockers. The necessary orchestration,
SDK IO, connection providers and custom host hooks already exist. A published
stock image encourages agents to search for configuration rather than compose
these primitives. Alpha can remove that distribution path cleanly.

## Decision

Distribute the Work server as `@catamorphic/work-server`. Deployments own a
small TypeScript entry point, dependencies and image, pinned to a Work release.
Remove the stock Dockerfile and image publication workflow. `apps/server`
remains the development/reference host and worker process source. Companies
may copy these entry points into their builds; there is no stock base image.
Worker installation uses an explicitly supplied `workerImage` or
`WORK_WORKER_IMAGE`, never an inferred official image. Sandbox images remain
Environment choices and recipe files.

Glue code is normal. Project workflows compose durable boundaries, events,
SDK IO and application-owned storage; host hooks implement privileged calls,
authorization and callback routes. WorkServerHooks forwards the existing SDK
`capabilityProviders` contract alongside brokered connection providers. An
external process launched by a workflow need not become an enrolled worker.

Do not add a native integration or framework table for each application.
Distinguish a missing core guarantee from application orchestration and test
it before proposing a new abstraction. Retain explicit authority boundaries.

## Consequences

Release publication covers the desktop and libraries, without a Work server
image. A deployment builds and verifies its own server and worker images,
including shutdown, PWA assets when used, and required runtime tools. Existing
published images are historical artifacts and are not deleted by this change.
Setup and agent guidance lead with composition and state the current limits
of cancellation, waits, signals and external effects.
