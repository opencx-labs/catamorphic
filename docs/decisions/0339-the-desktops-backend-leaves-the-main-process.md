# 0339 — The desktop's backend leaves the main process: its database first, then the server

- **Status:** Accepted (amended by [0341](0341-the-engines-boundary-one-interface-then-the-fork.md))
- **Date:** 2026-11-19

## Context

Electron's main process routes input, window management and IPC for every
window on one JavaScript thread. The desktop runs its whole backend on that
thread too: Fastify, core, harness supervision and PGlite, which is
Postgres compiled to WebAssembly and runs each statement to its end on the
thread that issued it. Whatever the backend does, every window waits for.

Measured (`apps/desktop/docs/performance.md`): on an installed app with
nine agents working, that thread was 11 to 23% busy. In the isolated test
desktop one live turn kept it busy 153 ms of every second, 93 ms of them
inside PGlite; ten openings of a 1,000-item chat, 177 ms a second, 75 in
PGlite. On a long-used profile one chat's 3 MB snapshot took 117 ms to
read, and a table compaction 1.3 s (ADR 0319). ADRs 0229, 0319 and 0338
each moved a hot spot; the class of problem remains.

## Decision

Two steps. Each ships alone, and the second keeps the first.

**1. The database runs on a thread of its own.** PGlite opens in a worker
thread (`main/server/database-thread-worker.ts`). Its callers keep what
they use of it (`query`, `exec`, a transaction, `close`) through a client
that numbers requests over the thread's port (`database-thread.ts`). A
transaction stays open in the worker for the statements its caller sends,
so Kysely's PGlite dialect runs unchanged, savepoints included. A Postgres
error crosses with its code and constraint. PGlite still runs one
transaction at a time and queues the rest, so order and isolation are what
they were. With it, the same live turn keeps the main thread busy 60 ms a
second, chat openings 92, and the turn takes as long as before.

**2. The server runs in a process of its own.** An Electron utility
process, the engine, boots the server the main process boots today:
Fastify, core, the database's thread, harness supervision, the workers.
The main process becomes a client like its windows: data over the loopback
API, and surfaces (windows, tabs, terminals, dialogs, notifications) over a
typed channel the engine calls back on. The engine owns what lasts (the
database, profile stores, credentials); the main process owns what shows.
In stages:

1. The engine boots `boot.ts` with its configuration passed at the fork.
   `WorkspaceBridge` and the host callbacks cross a MessagePort. The main
   process stops holding `EmbeddedServer`: its 28 members and about 100
   call sites (76 in `ipc.ts`) become API calls, desktop-only routes, or
   events. The four synchronous reads (`projectRoots.getSync`) read a
   mirror the engine keeps current.
2. The stores both sides read from files (profiles, agents, connections,
   approvals) move to the engine, one owner at a time. `safeStorage` does
   not exist in a utility process: the main process unwraps one key and
   hands it over at the fork, or brokers each decryption (ten modules use
   it today).
3. Running without windows becomes the engine without a main window,
   replacing the relaunch into `--background-runtime`.

Considered:

- **Step 1 alone.** Leaves 60 ms a second per turn of query building,
  validation, JSON and harness output on the window's thread, and the
  backend's memory and crashes in the process that owns the windows.
- **Step 2 alone.** Far longer before anything improves, and inside the
  engine a slow statement would still delay every API answer and stream,
  so the thread is wanted there too.
- **A plain Node or Bun child instead of a utility process.** Nothing in
  `server/` but `boot.ts` and `paths.ts` imports Electron, so it could
  run. A utility process keeps MessagePorts to the main process and
  windows, the app's lifetime and signature, and one runtime to package.
- **More hot spots moved one by one.** What ADRs 0229, 0319 and 0338 did.

## Consequences

- Step 1 is in this change. Its unit tests run the protocol over a
  channel in one thread against a real PGlite (statements, value types,
  commit and rollback, Postgres errors, ordering, Kysely with savepoints,
  loss of the thread, closing, what the channel cannot carry), and the
  desktop's end-to-end suite runs on the thread itself. On Linux with Electron 45.3, a worker whose script sits
  in the app archive starts and opens PGlite from the unpacked folder
  beside it. A signed macOS build has not been run with it: the packaged
  startup smoke covers that before a release carries this.
- Work that only touched the database used to run to its end before any
  other request began, because PGlite answered within one turn of the
  event loop. Now requests interleave between statements, as they always
  have on a Postgres server. Core holds its transactions and locks for
  that case; the desktop's own stores issue single statements or hold
  their own locks. Four places relied on the old order and now state it:
  a quick click on the microphone, which a preview of its own first words
  kept on; the pull request tool, which read a chat's checkout and then
  wrote its branch (one statement now); and two end-to-end tests, one
  attaching to the chat it opened and one scripted agent ending before its
  question was answered.
- A database thread that ends while Work runs is not replaced under its
  callers: every statement after it fails, so Work says its database
  stopped and closes. One that never opens fails the boot, as before.
- Work in flight at quit now spans turns of the event loop, where it used
  to finish before shutdown reached the database. The last shutdown step
  waits, for up to a second, until nothing has been asked of the database
  for 20 ms and no transaction is open, and only then destroys Kysely,
  which refuses new work from that moment: a delivery the quit caught
  between two statements sends the second. What still comes after is
  refused.
- Kysely's PGlite driver waits for a transaction's callback to be entered
  and listens for nothing else. A transaction refused before it (the
  database closing, or lost) was a rejection nobody heard and a caller
  waiting for good, holding Kysely's one connection. The client always
  enters the callback: a transaction that could not begin fails its
  statements and its end.
- A statement's result is copied between threads. Copy included, opening
  a 1,000-item chat costs the main thread about 21 ms where it cost 41.
- The stock server opens PGlite the same way and serves several people
  from one thread. The thread belongs in a shared package once it adopts
  it.
- Step 2 changes what a crash means: an engine that dies takes running
  turns with it and needs a visible restart, where today it takes the
  windows too. Sleep (leases are released before the freeze), shutdown
  order (HTTP, core, harnesses, the database last), the update hand-back
  (ADR 0246) and the pre-migration backup each cross a process boundary
  and need their own tests. Whether harness children started by a utility
  process keep the app's macOS permissions has to be measured, not assumed.
- Each stage of step 2 gets its own decision record as it is designed.
