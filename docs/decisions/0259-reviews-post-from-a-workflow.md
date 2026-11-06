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
chat, push through its Git route, or forge the transcript. Nothing signed in
that sandbox can be trusted, so the fix is placement: the sandbox holds no
GitHub write capability at all.

## Decision

**The review chat only reads.** Its binding keeps `get`,
`pull_request_files`, `review_threads`, and `git:read`; the reviewer's
sandboxing is `contained`, so no push, proposal, or publish leaves it. There
is no `git:write`: the pull request's code could push with the chat's grant,
a fork's commits into a branch of the base repository, and pushes made with
the App's token run that repository's `on: push` workflows with its secrets.
Fix branches are out of the recipe; a team that wants them gives them to a
separate chat that never runs the pull request's code. The chat ends every
turn with one fenced `work-review` JSON block (verdict `COMMENT` or
`REQUEST_CHANGES`, score, summaries, inline comments, threads to resolve, an
answer, the commit reviewed): a report, untrusted data.

**A workflow outside the sandbox posts it.** `postReviews`, project code in
the recipe, runs on `session.turn-changed` in a workflow-only `github-poster`
Environment. It posts only for the reviewer's project chat in `review` that
`reviewPullRequests` started, keyed exactly `pr-<owner>/<repo>-<number>`;
the repository and number come from that key. It validates the block with
size caps, defuses mentions and HTML comments in its text, and drops a
report for any commit but the one the chat stands on. It posts inline
comments only on diff lines, adds no review for a turn that only answers a
question, keeps a summary between markers in the description, resolves the
App's own threads, and answers the question. Each step returns one call,
carries the turn with `{ state }` (ADR 0260), and retries; each write
passes the turn's stamp, which the action checks, so neither a retry nor a
rerun posts twice.

**A commit's verdict only holds or tightens.** The "Work review" check run
is `failure` for requested changes, `success` when nothing blocks, and
`action_required` (never passing) when no usable review came. On one
commit a failure stands until the next push, a success gives way only to a
failure, and a turn without a review marks a commit only while none of the
App's runs has; runs other apps name alike do not count. The App's earlier
change requests are dismissed once a later commit passes.

**The review is advice, not a merge gate.** The pull request's code runs
where the review is written, so it can sway the verdict, the check, and the
dismissals on its next commit. Branch protection should require a person's
approval, and a required check should name the App as its source.

**Typed actions, scoped to their own items.** The GitHub provider gains
`review_threads`, `check_runs`, `resolve_review_thread`,
`update_pull_request`, `list_reviews`, `dismiss_review`,
`reply_to_review_comment`, `update_issue_comment`, and
`delete_issue_comment`, and a `stamp` on `create_review`,
`create_check_run`, `issue_comment`, and replies. Each mints a token for the
repository and the one permission it needs (a conversation comment reads
whether its number is a pull request or an issue). An action that changes
or removes an item refuses one the connection did not write: the App's bot,
or the connected person, whose own full token a member connection uses.
Resolving checks through GraphQL that the thread is the pull request's and
the App's; resolving (20) and dismissing (100) take lists, each item checked
before any changes. A REST read GitHub fails with a server error throws, so
its caller retries. GraphQL's address follows the REST base.

Considered: raw REST write verbs for the poster (a verb reaches everything
the App may do in the repository, anyone's comments included), GraphQL
passthrough (no narrowing, and guards cannot see what it does, ADR 0162),
and a signed result from the chat (whatever signs it runs in the sandbox).

## Consequences

A hostile pull request can mislead the review about itself, which a
person's approval catches; it cannot approve, push, reach another pull
request, or touch anyone else's comments. The App needs Pull requests:
write, Checks: write, and Contents: read; Issues: write only for editing or
deleting conversation comments, which the poster does not do. Reading the
description and writing it back can lose an edit made in between; the
summary lives between markers so the rest is kept.
