# 0306: Typed private Work customizations

- **Status:** Accepted
- **Date:** 2026-11-06
- **Amends:** 0069, 0134, 0139, 0234, 0239, 0277

## Context

Building a personal todo sidebar exposed missing packaged workflow assets,
unpublished source types, different app and source invocation contracts,
view-dependent context, stale code and errors, repeated approvals, and no
private automation lifetime independent of a chat. The person approved clean
breaking changes, reusable state and processes that survive quitting the UI,
and real-agent evaluations instead of relying on example text alone.

## Decision

Work's public customization contract lives in `@catamorphic/work-customization`,
not core. It describes Work layouts, rows, actions and source context. Generic
collections and transport-neutral workflow invocation stay in `@catamorphic/app`.
The desktop consumes these public contracts. Visibility does not grant context;
authorized current-surface context, navigation and contextual indication are
independent. Source actions receive one normalized opening intent and mode.
Presentation has one override order: source row, item defaults, item overrides.

The installed SDK, a static checker, and a preview using the actual confined
source runtime are discoverable together. Imported-code edits reload sources;
diagnostics identify the executing revision. A canonical package location is the
approval boundary, within its profile and project. Broader access requires consent;
changing code within allowed reach does not. Confinement remains mandatory.

Core retains member-owned immutable workflow artifacts independently of sessions,
and runs them through ordinary enablements, schedules and Runs. Private state uses
the existing versioned document machinery, with explicit ownership and conditional
writes. Notifications use the durable event/delivery path and host-injected
transports. These are host-neutral capabilities, not sidebar or todo services.
Private state and source are not uploaded merely because a server is connected.
Member source files live in the retained revision journal, pinned by SHA-256.
These opaque source pins use existing artifact `commitSha` fields; they are not
Git commits and never require writing the user's repository.

Background processes use existing provider operations behind an explicit owner,
lifetime and stop surface. Quitting Work's UI does not stop enabled background
services. A host-owned supervisor retains their authority and confinement; a
renderer, source subscription or archived creating chat is not their lifetime.
PGlite always has one owner. Persistent service definitions are authenticated by
the host approval key and state version; ordinary private-state access cannot
create or replay them. View leases are independent of package-wide application
services. A running OS process is not durable workflow state.
On macOS, source and managed command confinement denies forking; commands replace
their launcher so they cannot daemonize outside supervision. Linux uses its PID
namespace for child teardown. Multi-process logic runs through isolated workflows.

Guidance is a short factual entry point plus tested reference examples. Work's
replaceable design hints describe its narrow sidebars, native density and quiet
defaults; application-specific rules stay with that customization. Parameterized
real-agent evaluations retain source, transcripts, runtime checks and results.

## Consequences

There is no second workflow scheduler or customization language. Agents can type
check what they write and test real interaction contracts without changing the
person's workspace. Breaking source/layout/access changes include repair examples
in the release-facing PR. Runtime placement and private-to-shared transfer remain
explicit choices. Host lifecycle and real confinement need integration coverage.
