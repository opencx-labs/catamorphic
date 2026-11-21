# 0341 — A workspace is saved as a Git pack, as it is restored

- **Status:** Accepted (amends [0178](0178-session-workspaces-at-a-ref.md) and [0191](0191-member-drafts-are-refs-in-the-project-origin.md); amended by [0342](0342-every-server-chat-stands-on-a-branch.md): a save also carries the agent's commits and branch, and no workspace is restored from text)
- **Date:** 2026-11-20

## Context

A sandbox's workspace is saved to the session's copy (or a member's draft)
after every settled turn and before it is given back, and restored into the
next sandbox. Restoring was already Git-native: one pack, uploaded as
base64 and installed with `git index-pack`. Saving was not. It listed the
changed paths and read each with `SandboxProvider.downloadFile`, which
returns a string on every provider, then wrote that string. After one
release and restore a 200,000-byte binary came back as 363,888 bytes, an
executable lost its bit, and a link came back as a copy of its target. Each
changed file was also its own remote operation.

## Decision

**Saving uses the mechanism restoring uses: a Git pack carried as base64.**
One command in the sandbox snapshots the working tree (as before), packs
the blob of every changed file and link, and adds a manifest blob: the
NUL-separated `git diff-tree --raw` between the last saved tree and the
snapshot, so each path travels as its own bytes with its mode and blob id.
The pack waits in the sandbox's Git directory as base64 and is read through
`executeCommand` in 4 MiB chunks, the first with the snapshot itself. A
small save is two remote operations (snapshot, mark), whatever the number
of files. No provider contract changes.

**The control plane trusts nothing it reads.** The pack is indexed by
native Git in a repository of its own that is thrown away, so damaged or
truncated bytes fail Git's checksums instead of being saved. Every path is
refused if it is absolute, leaves the checkout, or passes through a Git
directory (by any case or filesystem alias); modes are `100644`, `100755`
or `120000` only; ids, sizes and chunk counts are bounded. A refused save
is a `SandboxSyncError`: nothing is marked as saved and the workspace is
kept.

**A link is saved as a link and never followed.** In a checkout, parents
must be real folders, and what stands at a path is replaced by rename,
never opened, so a link saved earlier cannot redirect a later write. In a
member's draft, `OriginDraftRepo.write` takes a file's Git mode and, for a
save (`replaceLinks`), replaces or deletes a link's own entry. Reading a
whole managed checkout skips links. A person's own folder is the one place
whose file APIs follow links, so there a link is kept only when it points
inside the folder; one that leads outside refuses the save.

Considered and rejected: one command emitting `mode, path, base64` records
(no integrity check, no compression, a second format beside the pack);
indexing the pack into the session's copy (every turn would leave a pack
there for isomorphic-git to load, and hostile objects would outlive the
save); widening `downloadFile` to bytes (a contract change on every
provider and transport, still one operation per file).

## Consequences

- Bytes, executable bits, links and deletions survive a release and
  restore; the round trip is tested with real local-process and container
  sandboxes.
- Git's clean filters still apply to the snapshot, as they do to any
  commit: a sandbox that configures `core.autocrlf` or Git LFS saves what
  Git would commit.
- Nested repositories (gitlinks) are skipped instead of failing the save.
- A workspace without a base is still restored by uploading text
  (`readAllFiles`), which carries no binary files, modes or links. Making
  that restore a pack too is follow-up work.
