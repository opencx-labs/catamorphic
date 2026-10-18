# 0259: Reviews post from a workflow

- **Status:** Accepted
- **Date:** 2026-10-18
- **Refines:** [0177](0177-github-is-a-connection.md), [0181](0181-project-chats-use-their-environments-bindings.md)

## Context

The pull request review recipe (ADR 0181) had the review chat post its own
review, check run, and answers through the `review` Environment's `github`
binding. That chat's sandbox also runs the pull request's code: its install
scripts, tests, and services. With harnesses that run in the sandbox (Claude
Code, Codex, ACP agents), the agent runner and the session's grants live
there too (ADR 0175), so the change under review can call the gateway as the
chat and write whatever the binding allows, or forge the transcript. Nothing
signed inside that sandbox can be trusted, so the fix is placement: the
sandbox must hold no GitHub write capability at all.

## Decision

**The review chat never writes to GitHub.** Its binding keeps reads (`get`,
`pull_request_files`, `review_threads`, `git:read`) and, when fix branches
are wanted, `git:write` limited to `work/*`. It ends every review turn with
one fenced `work-review` JSON block: a verdict (`COMMENT` or
`REQUEST_CHANGES`, never an approval), a score, a summary, the check's
summary, inline comments, threads to resolve, an answer to an `@work`
question, and the commit it reviewed. The block is a report, untrusted data.

**A workflow outside the sandbox posts it.** `postReviews` is project code
in the recipe, bound to `session.turn-changed` (completed and failed) for
the review chats' key prefix, enabled in a workflow-only `github-poster`
Environment whose `github` binding holds the typed write actions. It reads
the turn's reply with `history({ through })`, validates the block against a
strict schema with size caps, and takes the repository and number from the
chat's key, never from the block. A block for any commit other than the one
the chat stands on (`inspect().workspace.commit`) is dropped. It posts
inline comments only on lines the diff has, keeps a summary between markers
in the description, reports the check run (neutral for a failed turn or an
invalid report), dismisses its own earlier change requests once nothing
blocks, and resolves the threads the block names that the App opened. Each
step returns one call and carries the turn to the next with `{ state }`
(ADR 0260). Each GitHub write is its own step's call and carries a
`turn=<turnId>` stamp (a check run's external id), so a rerun of the turn
finds what it already posted.

**Typed actions, scoped to their own items.** The GitHub provider gains
`review_threads`, `resolve_review_thread`, `update_pull_request`,
`list_reviews`, `dismiss_review`, `reply_to_review_comment`,
`update_issue_comment`, and `delete_issue_comment`. Each mints a token
narrowed to the repository and the one permission it needs. An action that
changes or removes an existing review, thread, or comment refuses one the
connection did not write: the App's bot (`<slug>[bot]`), or the connected
person for a member connection. Resolving first checks through GraphQL that
the thread belongs to the named pull request and that the App opened it.
Resolving and dismissing take up to twenty items, every one checked before
any changes, and skip what is already resolved or dismissed; a thread's
reply rides on its resolve and is posted only if the thread does not already
end with it. So the poster needs no loop, and a retry repeats nothing.
GraphQL's address follows the REST base (`/api/graphql` on Enterprise
Server).

Considered:

- **Raw REST write verbs for the poster.** A capability is a verb, so
  `patch` and `delete` reach everything the App may do under
  `/repos/{owner}/{name}`: anyone's comments, the pull request's base,
  labels, releases. A forged id or a bug in the poster would touch people's
  work. Path-scoped REST capabilities would be a new binding model.
- **GraphQL passthrough.** A query names any node the installation reaches,
  so its token cannot be narrowed by reading the request, and guards could
  no longer see what an action does (ADR 0162).
- **A signed result from the chat.** Whatever signs it runs in the sandbox.

## Consequences

The worst a hostile pull request can do is report something misleading
about itself, which the poster bounds: it cannot approve, cannot reach
another pull request, cannot change anyone else's comments, and holds no
GitHub write access. Reviews reach GitHub a few seconds after the turn ends. The App
needs Issues: write to edit or delete its conversation comments, beside
Pull requests: write and Checks: write. Reading the description and writing
it back can lose an edit made in between; the summary lives between markers
so the rest of the description is kept.
