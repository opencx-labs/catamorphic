# 0341 — The engine's boundary: one interface each way, a key, then the fork

- **Status:** Accepted (amends 0339)
- **Date:** 2026-11-20

## Context

ADR 0339 moves the desktop's server into a utility process, the engine, and
asks each stage for its own record. This is stage 1: the engine boots
`boot.ts`, and the main process stops holding `EmbeddedServer`.

Read from the code, the boundary is wider than a fork. `EmbeddedServer`
hands the main process live objects (core, the agent registry, its stores)
that six modules reach at about 100 places, with closures among the
arguments (`projectRoots.register({ reopen, create })`) and megabytes among
the results (a chat's snapshot, read to learn whether it is running). The
other way, `startEmbeddedServer` is handed live objects too: the workspace
bridge (27 methods, four of them cancellable), connectors, MCP apps,
approvals, the profile stores, and callbacks set on the registry after
boot. And the server reads six of those stores' secrets synchronously
through `safeStorage` (agents, agent bindings, connections, remote links,
the runner key, the credential vault), one of them on every project
request (`remote-api.ts`). A utility process has no `safeStorage`, and a
broker across a port can only answer later.

## Decision

**One typed interface each way, over one channel.** Requests are numbered
and always answered; events are one-way; everything is structured-clone
data (`main/engine/channel.ts`, the database thread's pattern).

- `EngineApi`, main to engine (`main/engine/api.ts`): each operation the
  main process may ask is named there and allowed in `engine/service.ts`.
  A member of `EmbeddedServer` becomes an **operation** (project folders,
  checkouts, workspace state, the registry's questions, GitHub,
  customization processes, sign-in recovery, suspend, resume, hand-back,
  shutdown), an **event** (chats changed, personal environment, files
  moved, harness download progress, the database lost), part of the
  **mirror**, or **stays in the main process** because it only read
  main's own state (`remoteTerminalRequest`, `mcpAppViewUrl`, a project's
  default agent). Closures become data the engine acts on; a result is
  what its caller needs, never a snapshot. An error crosses as its name,
  message and plain fields.
- **The mirror.** The engine is the only writer of project folders and
  sends each change before the answer to the request that made it, so the
  four synchronous reads, and every `projectRoots.get`, read a map in the
  main process that is current when their caller resumes. The API's
  address and token arrive with `ready`.
- `EngineHost`, engine to main: what shows. The workspace bridge (a
  cancellable call carries an id, and its `AbortSignal` becomes a cancel
  message, as a source view's lease already does), notifications,
  elicitation, a window's profile, the person's place, voice, and the
  keychain for approvals.
- **A call nobody waits for** (sleep, a sign-in nudge, a closed view) is
  told: sent at once, its failure logged, never a rejection. **At quit**
  the channel finishes what was asked before `shutdown`, whose answer
  comes after today's order (HTTP, core, harnesses, the database once it
  is quiet), then closes: what never settled fails its caller and what
  is asked after is refused.

**Two changes to ADR 0339.**

1. *The main process reaches the engine over the channel, never over the
   loopback API or desktop-only routes.* The API forwards a linked
   project's requests to its server, and the main process asks about the
   local copy. And the API's token rides on every admitted shell frame, so
   a desktop-only route would be a window's to call without the checks its
   IPC handler makes (which window, which profile). The windows keep the
   API; nothing about it changes.
2. *The stores' key is handed over before the fork*, not after it. ADR
   0339 forks in stage 1 and unwraps a key in stage 2. The fork cannot
   read six stores without `safeStorage`, so the key comes first; the
   stores' own move stays in stage 2.

**Three slices, each shipping alone.**

1. **The seam** (this change). The main process reaches the server only
   through `EngineApi`. Both ends still run in the main process, over a
   real `MessageChannel`, so anything live fails to cross today, in every
   test and in the app. Nothing is faster yet.
2. **The other direction, and the key.** What `startEmbeddedServer` is
   handed becomes `EngineHost` and data. The stores' secrets are sealed
   with one key that `safeStorage` wraps; the main process unwraps it and
   hands it over, so either process reads the stores from their files.
   Its own record settles the migration and a locked keychain.
3. **The fork.** `utilityProcess.fork` serves the same two interfaces.
   Start: windows open on their backdrop as today, the login shell's PATH
   is adopted and the pre-migration backup (ADR 0083) taken in the main
   process, then the engine is forked with its paths and environment, and
   `ready` brings the address the windows mount on. Quit: the main process
   stops what shows, asks for the hand-back when updating (ADR 0246), asks
   `shutdown`, and waits for the engine to exit; one that has not is
   killed and the quit reported unclean. Sleep sends `suspend` at once, as
   today's call is not awaited either. An engine that ends unasked fails
   every waiting request; the main process says so, returns the windows
   to their backdrop and starts another, and closes Work as a lost
   database does today if that one ends too. `--background-runtime` stays
   a main process without windows that forks the same engine, until stage
   3 replaces it. The port is the main process's alone; the engine still
   listens on loopback only, and mints the token.

Considered: **the fork now, with the stores brokered.** Every store read
on the server side would turn asynchronous in the change that moves the
process. **A generic proxy of `EmbeddedServer`**: it would carry snapshots
and closures across, and name nothing. **A direct transport until the
fork**, copying only under test: the app would then run a path its tests
do not, which would leave the boundary untested in daily use.

## Consequences

- The main process holds no object of the server's. What it still
  imports from `server/` are constants and helpers that run where they
  are called. A new need of the main process is a named operation.
- A call that was one synchronous hop is a message each way, copied twice
  on the main thread until the fork. In three paired isolated Linux runs,
  posting the channel's messages took 2.25 to 2.93 ms total across ten
  reopenings of a 1,000-item chat. End-to-end timings varied across the
  two series of paired runs.
  [Performance measurements](../../apps/desktop/docs/performance.md#the-server-message-boundary-2026-11-21)
  record both series and whole-main-thread CPU.
- Two orders changed and are now stated. The `server-changed` broadcast
  after an agent changes needs an answer from the engine, so the handler
  waits for it before it returns: a window still hears it before its own
  call resolves. A folder reopened by a link is checked against its
  profile after the engine answers, not inside the registration.
- Harness children of a utility process: Electron documents that
  `utilityProcess.fork` does not disclaim responsibility unless asked
  (`disclaim`), so macOS should keep attributing them to Work. That is a
  reading, not a measurement. Slice 3 measures it on a signed build (the
  responsible process of a harness child, and a folder prompt that names
  Work) before it ships, and measures the main thread again.
- Slices 2 and 3 are not in this change.
