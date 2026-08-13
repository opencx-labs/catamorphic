# 0044 — Checkpoint commits, remote sync, and the code-host seam

- **Status:** Accepted
- **Date:** 2026-08-13
- **Builds on:** 0043 (general-purpose projects), 0032 (dev/origin git model)

## Context

Non-technical users must have their work tracked well without ever seeing
git. Today nothing closes that loop: agent turns land as uncommitted
drafts in the dev working copy (host harnesses edit the folder in place
and commit nothing), the internal origin only moves on create/import and
explicit deploy, and a GitHub-linked project can push manually
(`pushProject`) but never pulls. Meanwhile two side channels already
commit into the user's real folder per turn (`syncTypes` generated-type
commits, `commitDevTree` for app publishes) — so history exists, it just
isn't the *work's* history.

The collaboration direction (companies running a shared project as their
"brain") needs local↔remote sync that is trustworthy and invisible, and
it must not weld Catamorphic to GitHub: GitLab, Cloudflare-hosted git,
or git bolted onto S3-compatible storage are all plausible backends.

## Decision

### 1. Every agent turn that changed files ends in a checkpoint commit

At the point where both harness families converge after a turn (sandbox
sync-back done / host edit events collected), the dev repo commits all
dirty state with an agent-authored message derived from the turn, and the
resulting sha is stamped on the assistant message row
(`agent_messages.commit_sha`, a column that existed unused).

**Why per-turn is worth it:**
- A turn is the product's natural unit of change — it is what the chat
  timeline shows, what `changedFiles` is recorded against, and what a
  user means by "what did it just do". `commit_sha` per message makes
  every reply's diff addressable forever (the git-changes tree view, and
  later undo, fall out of it).
- Commits are cheap, and the precedent already existed: `syncTypes` has
  been committing after settled turns all along. Checkpoints replace
  scattered incidental commits with a coherent record.
- History noise is a *sharing-time* problem, not a recording-time
  problem: main's fine-grained local history can be squashed at the PR
  boundary when a change is shared for review. Never at checkpoint time.

**Checkpoints sweep the whole dirty tree**, not just the reported
changed files. Host harnesses under-report (shell-created files carry no
file_edit event; deletes are invisible), and the user may have hand-edits
in flight — a checkpoint is "the project as this turn left it", not an
authorship claim. Commits use a dedicated agent author so agent activity
is distinguishable from human commits. A checkpoint failure logs and
never breaks the turn.

**Consequence for "draft":** a draft is no longer an uncommitted tree; it
is *local commits not yet pushed*. Deploy already handles
clean-but-ahead trees; `discardDraft`'s reset-working-tree semantics
weaken and will be reworked into reset-to-synced-state when the desktop
grows a history surface.

### 2. Sessions share the project folder; no worktree per session

Considered and rejected (for now): a git worktree per chat session. The
desktop's whole surface model — terminals cwd'd to the project, editor
tabs, the browser of local files, "the user watches the agent work" —
points every surface at ONE folder. Worktree-per-session would make the
visible folder ambiguous and break live visibility, which is the product.
Concurrent sessions interleave in one tree and their checkpoints
interleave on main; that is honest and legible. Worktrees stay reserved
for a future *explicit* parallel/background-session feature (Claude
Code's native worktree support is the obvious mechanism when we get
there), where isolation is the point and the UI says so.

### 3. Remote sync is an engine over generic git, with a policy

`syncWithNetworkRemote` (in `@catamorphic/git`) knows only a repo, a URL,
credentials, and a branch. Policy, in order:

- not on `main`, e.g. mid-deploy → no-op
- remote branch missing → push (creates it)
- equal → up-to-date
- local behind, tree clean → fast-forward pull
- local behind, tree dirty → defer (never merge over live edits; retry
  on the next trigger)
- local ahead → push
- diverged → attempt a 3-way merge with `abortOnConflict` (the working
  tree is NEVER left with conflict markers by a background process);
  clean merge → push; conflict → push local main to a **rescue branch**
  on the remote and report it, so no work is ever stranded locally even
  when automatic merging fails. Resolution then happens at review level
  (a PR from the rescue branch), not in the user's tree.

`RemoteSyncService` (core) wraps the engine with project rows
(`remote_url`/`remote_branch`), per-project in-flight coalescing, and
credential resolution. The desktop triggers it fire-and-forget: after
each settled turn, at boot, and on an interval. Sync must never block or
break a chat turn.

### 4. The code-host seam: `CodeHost`

Everything provider-specific sits behind one interface:

```ts
interface CodeHost {
  id: string;                              // "github"
  handles(remoteUrl: string): boolean;
  credentials(identity): Promise<GitCredentials | undefined>;
  createPullRequest?(identity, input): Promise<{ url; number }>;
}
```

The sync engine needs only `credentials`. PRs (and later: invites, repo
creation) are optional capabilities — a plain git URL or an S3-backed
remote syncs fine with a host that offers nothing else. GitHub is the
first implementation (`GithubService.codeHost`); GitLab or a
Cloudflare/S3 backend is a new implementation, not a rewrite. Core and
the sync engine never import anything GitHub-specific.

### 5. Agents get explicit git verbs, not raw git

Two workspace tools — `sync_project` (run the sync policy now, report
the outcome in plain terms) and `create_pull_request` (push HEAD to a new
remote branch, open a PR via the host's capability). The playbook teaches
the policy: work is checkpointed automatically; sync happens
automatically for linked projects; reach for a PR instead of direct push
when the change is risky, collaborators are active, or the user asks for
review. Host harnesses could always run `git` in a terminal; the tools
exist so both harness families behave identically and outcomes surface
as structured events.

## Consequences

- Every project accumulates real history with zero user ceremony;
  `commit_sha` per assistant message makes turns addressable.
- Linked projects converge with their remote without user action, and
  divergence degrades to a reviewable branch instead of a stuck state.
- Supporting a new git backend = one `CodeHost` implementation.
- Checkpoint sweeps can fold a user's concurrent hand-edits into an
  agent-labeled commit — accepted; attribution lives at the review
  boundary, not per checkpoint.
- The registry `git-panel`'s draft-centric assumptions (dirty tree =
  draft) need updating to the commits-ahead model.
