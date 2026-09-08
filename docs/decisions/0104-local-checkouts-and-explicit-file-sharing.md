# 0104: Local checkouts and explicit file sharing

- **Status:** Accepted
- **Date:** 2026-09-08
- **Refines:** 0043, 0044, 0045, 0055, 0063

## Context

Opening an existing repository currently writes seeds, commits pending work,
and copies history into a second origin. Whole-tree checkpoints and automatic
store uploads also confuse saving locally with recording or sharing work.
Large software repositories and private documents require these actions to be
independent, without changing the host-owned identity and storage model.

## Decision

Opening an existing Git checkout registers it without changing its files,
index, branches, or remotes. The desktop discovers canonical repository paths
with native Git and uses native Git for local repository operations. A clone
creates one checkout and preserves its branch. New project initialization is a
separate operation. Registration is idempotent and borrowed folders are never
removed during rollback.

Local repositories supply their existing Git objects directly. Explicit
publication retains a commit under Catamorphic-owned refs, without changing
the user's branch or using external remote-tracking refs. Shared hosts retain
injectable remote storage. Source selection is per project through the existing
ProjectManager/RemoteBackend contracts; there is no second project model.

Attached primary and external checkouts use explicit commits and sharing.
Managed agent worktrees and newly initialized projects may use automatic
checkpoints. Read-only conversations never stage unrelated work. Worktree
creation remains deliberate; execution, terminals, and review follow the
selected checkout. Repository instructions and development tools remain
unchanged. Framework skills and default environments do not require seeding
an imported repository.

Documents keep the existing program/store namespace and scope enforcement.
Saving a document locally, uploading it to a connected server, and recording
project files in Git are distinct operations. Local store files are visible to
local document tools; upload selects paths explicitly. New private files are
never implicitly enrolled by a pull or upload of other files. Synchronization
preserves existing files on first contact and preserves both sides of a
conflict until explicit resolution. Blob storage remains host-injectable;
local filesystem, database, and S3-compatible storage share the same document
API and access checks. Private store data never enters program history.

## Consequences

Imports and ordinary discovery do not traverse history or materialize entire
repositories. Reads are bounded and use repository ignore semantics. Existing
whole-checkout checkpoint and automatic sync defaults do not apply to attached
repositories. Shared published-policy reads remain isolated from private
working changes. Tests cover dirty checkouts, packed history, binaries, private
files, selected uploads, conflicts, MCP scope, and shared deployments.
