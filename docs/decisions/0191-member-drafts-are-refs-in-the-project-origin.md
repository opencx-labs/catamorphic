# 0191: Member drafts are refs in the project origin

- **Status:** Accepted
- **Date:** 2026-09-30
- **Refines:** 0044, 0055, 0099, 0166, 0178

## Context

On a Work server each member's draft of a program was a working copy on
the replica's disk (`WORK_DATA_DIR/projects/.../dev/<member>`), seeded from
the origin once and reused afterwards. Uncommitted edits existed only on
that replica. Behind a load balancer that routes each request to any
replica, `program_write` landed on one replica and `program_deploy` on
another answered `nothing-to-deploy` (issue #148), and a replaced replica
lost every draft on it. A control-plane replica must hold no durable state
(#146).

## Decision

**A member's draft is a ref in the project's origin:**
`refs/work/drafts/<member>`, named by `draftRef` in
`@catamorphic/workflow/project-layout`. `ProjectManager.openDraft` returns
an `OriginDraftRepo` for any project without a local folder. Without that
ref the draft is the published `main`.

- **Write:** file contents are written once as blobs; the trees and a
  commit are built on the draft (or `main`) and the ref moves with the
  origin's compare-and-swap. A lost race rebuilds only the trees on the
  winner and retries. Every server write is a draft commit; a batch
  (`program_write`, a sandbox sync) is one commit. Paths the project's
  `.gitignore` (or `node_modules`, `dist`, `.turbo`) keeps out of history
  are refused, as a checkout's commit skipped them; absolute paths are
  refused.
- **Read and list:** object walks at the ref, through a per-process cache
  keyed by origin and object id that is safe to lose. Reads of `HEAD`
  within one open see one commit, so files read together are consistent.
- **Status:** the files the draft changes since its merge base with
  `main` (found by the commit graph), its commits, and how far `main` moved.
- **Discard:** delete the ref.
- **Deploy:** squash the draft into one commit on `main` with the deploy
  message, then delete the draft only if it did not move meanwhile. When
  `main` moved since the draft's base, the trees merge three ways in
  memory (text files line by line); a conflict publishes nothing and
  reports the conflicted files, ours being the draft. A merge that leaves
  `main` unchanged publishes nothing. Pull and conflict resolution merge
  `main` into the draft the same way, as a draft merge commit.
- **Publishing files** (the desktop's publish of a member's local copy) is
  one commit on top of `main` that never touches a draft; given the `base`
  commit the files came from, it merges with what was published since and
  reports conflicts instead of overwriting.
- **Privacy:** what is guaranteed is that no read through the server's
  APIs (a draft, the published view, the file and diff routes) returns
  another member's draft or a session branch. Every ref a caller names is
  checked against git's ref-name rules, and the full ref it maps to must be
  a branch outside `sessions/`, compared without case (a case-insensitive
  disk opens `Sessions/` as `sessions/`). A commit id is read only when it
  is reachable from `main`, the member's own draft, or a branch the member
  may name (a bounded walk; anything unproven is refused), and a publish
  `base` must be an ancestor of `main`. Draft ref names and host folders
  escape upper-case letters, so ids differing only by case never collide.
  The program reader is a reserved id no user can hold and opens the
  published view, never a draft. Not covered: anyone with direct access
  to the origin's storage, and content a member published. Administrators
  do not list drafts. Drafts never expire.
- **Server branches are gone:** `/branches` and `/checkout`, and the
  `work/*` branch a deploy used to create, are removed.
- **Agents without their own session copy** checkpoint at the draft's tip,
  and their `store/` view is mirrored in a disposable host folder. Machine
  copies (session copies, members' copies on hosts without an origin) are
  prepared once per key in a process, and a copy whose seeding did not
  finish is started over instead of used.
- **Merges** report a file against a folder as a conflict, never render
  binary files as text or accept text resolutions for them, keep a
  resolved file's mode, and refuse ignored paths.
- Only code-host fetch and push, ADR 0178 mirrors, and proposals use real
  filesystems, and only ephemeral ones. A project in a local folder (the
  desktop) is still its own draft, unchanged.

**Origins must keep drafts safely.** `RemoteBackend.draftSupport()` says
whether an origin can: ref updates and deletes atomic across every process
using it, and draft refs no sandbox credential can read.
`ProjectManager.draftSupport()` checks once per process (the Work server at
boot; a check that errors runs again next time) and `openDraft` refuses
drafts otherwise. Object stores (Postgres,
S3) qualify when a probe shows the store enforces `If-None-Match` and
`If-Match` on writes and deletes; some S3-compatible stores ignore
conditional deletes and fail it. Bare repositories serialize their
compare-and-swap in one process and serve single-process hosts. Cloudflare
Artifacts does not keep drafts: sandbox clone tokens read every ref of the
repository. Its compare-and-swap updates now push without force, so a
lost race is refused by the server instead of overwritten.

Considered: keeping per-replica copies and routing a member's requests to
one replica (affinity breaks on every deploy and restart); keeping each
draft commit on `main` (publishes work-in-progress history nobody
reviewed); merging in ephemeral checkouts (copies the project's whole
history per merge).

## Consequences

Any replica serves any draft call, and a replica with an empty disk loses
nothing. A server write costs a few object writes and one ref update in
Postgres instead of a local file write; reads are cached by object id. A
publish that races another publisher retries on the new `main`. Hosts on
Artifacts, or on a store that fails the probe, have no server drafts
until they move origins. Session copies and the trigger scan cache still
live on replica disks (#153).
