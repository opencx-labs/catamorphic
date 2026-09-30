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

- **Write:** read the tree at the draft (or `main`), write blobs and trees,
  commit, and move the ref with the origin's compare-and-swap; a lost race
  is rebuilt on the winner and retried. Every server write is a draft
  commit, so "uncommitted changes" is no longer a server concept. A batch
  (`program_write`, a sandbox sync) is one commit.
- **Read and list:** object walks at the ref, through a per-process cache
  keyed by origin and object id that is safe to lose.
- **Status:** the files the draft changes since it last met `main`, its
  commits, and how far `main` moved since.
- **Discard:** delete the ref.
- **Deploy:** squash the draft into one commit on `main` with the deploy
  message, then delete the draft (only if it did not move meanwhile). When
  `main` moved since the draft's base, the two merge in an ephemeral
  checkout first; a conflict publishes nothing and reports the conflicted
  files, with ours as the draft. Pull and conflict resolution merge `main`
  into the draft the same way.
- **Publishing files** (the desktop's publish of a member's local copy) is
  one commit on top of `main` that never touches a draft.
- **Privacy:** drafts are private to their member. Reads through a draft
  refuse other members' drafts and session branches; administrators do not
  list drafts. Drafts never expire, so nothing is lost silently.
- **Server branches are gone:** `/branches` and `/checkout`, and the local
  `work/*` branch a deploy used to create, had no meaning for drafts and are
  removed.
- Only code-host fetch and push, ADR 0178 mirrors, merges, and proposals
  use real filesystems, and only ephemeral ones. A project in a local
  folder (the desktop) is still its own draft, unchanged.

Origins keep draft refs in every backend: object stores (Postgres, S3)
through conditional puts and deletes, bare repositories through a
per-process lock, and Cloudflare Artifacts by syncing `refs/work/drafts/*`
alongside branches.

Considered: keeping per-replica copies and routing a member's requests to
one replica (affinity breaks on every deploy and restart); keeping each
draft commit on `main` (publishes work-in-progress history nobody reviewed).

## Consequences

Any replica serves any draft call, and a replica with an empty disk loses
nothing. A server write costs a few object writes and one ref update in
Postgres instead of a local file write; reads are cached by object id. A
publish that races another publisher retries on the new `main`. Session
copies and the trigger scan cache still live on replica disks (#153).
