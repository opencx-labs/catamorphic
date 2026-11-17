---
name: github-polling
title: GitHub polling
description: How this project gets GitHub events without a public webhook URL: a schedule workflow polls the repository and records pull request and comment events of the project's GitHub trigger kinds. Use when adapting, debugging, or explaining the poller, its cursor, or missing or late GitHub events.
---

# GitHub polling

This project's Work server cannot be reached by GitHub, so GitHub's webhook
never arrives. Instead `pollGithub` (`.work/workflows/src/github-polling.ts`,
installed from the `github-polling` pack and the team's to change) reads the
repository through the project's `github` connection on a schedule and
records what changed as events of the project's own trigger kinds
(`.work/triggers/github.ts`). Workflows bound to those kinds, such as the
pull request reviews, run exactly as they would on a webhook delivery: they
never know the difference.

## What it records

| Kind | When | Event id |
| --- | --- | --- |
| `github.pull_request` `opened` | A pull request created after polling began | `pull_request:<number>:opened` |
| `github.pull_request` `synchronize` | A known open pull request's head changed (`before` and `after` set) | `pull_request:<number>:synchronize:<head sha>` |
| `github.pull_request` `ready_for_review` | A known draft is no longer a draft | `pull_request:<number>:ready_for_review:<head sha>` |
| `github.pull_request` `reopened` | A known closed pull request is open again | `pull_request:<number>:reopened:<when it had closed>` |
| `github.pull_request` `closed` | A known open pull request closed or merged (`merged` says which) | `pull_request:<number>:closed:<closed_at>` |
| `github.issue_comment` `created` | A person commented on a known pull request's conversation | `issue_comment:<comment id>` |
| `github.pull_request_review_comment` `created` | A person commented on a known pull request's diff | `pull_request_review_comment:<comment id>` |

Each payload is shaped like the webhook delivery of that event:
`x-github-event` and `x-github-delivery` headers (the delivery header is the
event id) and a body with `action`, the pull request as GitHub's REST API
returns it (plus `merged`), `repository.full_name` and `sender`. The REST
list does not say who acted on a pull request, so `sender` is its author.
The host adds `origin: { type: "workflow", workflowName, runId,
enablementId }`; a trigger that must accept only signed webhook deliveries
filters on `origin: { type: "request" }`.

An id is recorded once: a retried poll, an overlapping one, or a comment
edited later records nothing new. Ids name the change from what the cursor
remembered, never the pull request's state after it, so a poll that recorded
and then lost its cursor write records nothing twice when the next poll
finds the same change: a push in between is folded into that `opened` (the
review checks out the pull request's current head). Comments by accounts whose GitHub `type`
is `Bot` (including the App itself) are skipped by type, never by login.
Comments on plain issues are skipped too: GitHub's comment lists do not say
whether an issue is a pull request or its state, and the poller records
only what it can state.

## The cursor

The cursor is the project store document `CURSOR_PATH`
(`store/github-polling/<repository>.json`), written with `ifVersion` after
every poll, so two overlapping polls never move it backwards: the later
write fails and the next poll picks up anything it missed. It holds:

- `baselineAt`: when polling began. Nothing created before it becomes an
  event. **The first poll records nothing**: it remembers the most recently
  updated pull requests (one page) with their heads, so the existing
  backlog never floods the reviews.
- `pulls.known`: each remembered pull request's head, state, draft flag and
  title, which is how a push, a reopen or a close is told apart from a
  comment that only touched `updated_at`. A pull request older than the
  baseline that was not on the first page is learned silently the first
  time it changes; that first change is not recorded. Closed pull requests
  are forgotten after `KEEP_CLOSED_DAYS`, so a reopen after that is not
  recorded.
- `pulls.since`, `pulls.page`, `pulls.sweepTop`: pull requests are read newest
  change first, `PULL_PAGE` at a time. When a whole page is newer than
  `since`, the next poll reads the next page until it reaches what was
  seen, then starts again from the top.
- `issueComments.since`, `reviewComments.since`: comments are read oldest
  change first from GitHub's `since`, `COMMENT_PAGE` at a time. While a
  sweep is behind they stay where they are: a comment on a pull request the
  sweep has not reached was skipped, and is recorded once it has.

To start over, delete the document: the next poll is a baseline again.

Everything compared comes from one source, GitHub's REST API through the
connection's `get`, so text never differs between sources.

## The interval

The schedule polls every minute (`cron: "* * * * *"`). Each poll is one run
of four GitHub requests. A shorter interval is not possible with cron; a
longer one (`*/5 * * * *`) costs a fifth of the runs and requests and delays
every event by up to five minutes. GitHub's rate limit for an App
installation is far above a poll a minute. Events are at most one interval
late and arrive in the order the poll finds them, not GitHub's.

## Files

- `.work/project.json`: the `github-poller` Environment, for workflows only,
  binds the `github` service connection with just `get`.
- `.work/triggers/github.ts`: the GitHub trigger library (the same file the
  `pull-request-reviews` pack and `writing-workflows` ship). Its webhook
  verifies GitHub's signature, so `github.delivery` says `recordable: true`:
  without it the host refuses every recorded event of its kinds. The webhook
  stays declared, so the same kinds also fire if the server ever receives
  GitHub's webhook; with both, filter on `origin` to avoid acting twice.
- `.work/workflows/src/github-polling.ts`: `REPOSITORY` and `CURSOR_PATH` at
  the top, `planPoll` (pure: the comparison and the events), and the
  workflow's steps (read the cursor, list pull requests, conversation and
  review comments, record, advance the cursor).

## Turn it on and check it

1. Check the project (the project MCP `program_check` tool) and deploy.
2. Turn `pollGithub` on for the project in the `github-poller` Environment
   with its `github` connection. It declares `events:write`, which recording
   needs: whoever turns it on needs that permission and `automations:write`.
3. After the first run, the cursor document exists and no event was
   recorded. Open a pull request: within two polls an event
   `pull_request:<number>:opened:<sha>` exists and the workflows bound to
   `github.pull_request` start.

A poll that fails (GitHub answering 5xx, a list too large for one
response) fails its run and retries like any boundary; the cursor only
moves when a poll succeeds.
