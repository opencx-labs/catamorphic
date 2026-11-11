# 0310 - Linux CI on GitHub-hosted runners

- **Status:** Accepted (amends 0129)
- **Date:** 2026-11-11

## Context

ADR 0129 put Linux CI on the organization's Blacksmith Ubuntu runners
(8 vCPU). The organization is cancelling Blacksmith: its main repository now
runs CI on the organization's own self-hosted AWS fleet, which leaves this
repository's Linux CI (about 90 runs a week) as the last Blacksmith user.

## Decision

Run every Linux CI job on GitHub's standard `ubuntu-latest` runner. For a
public repository it is free and has 4 vCPU and 16 GB. Everything else in
0129 stays: the lanes, file sharding, shard counts and caps, isolation, and
GitHub-hosted macOS.

Considered:

- **The organization's AWS fleet.** Not for a public repository: pull requests
  from forks would run their code on self-hosted runners inside the
  organization's AWS account.
- **GitHub's 8-core larger runners.** Blacksmith's speed, but billed even for
  public repositories ($0.022/min, about $750 a month at current volume).
- **Keeping Blacksmith.** Being cancelled.

## Consequences

Each shard has half the vCPUs it had on Blacksmith, so shards take longer.
Shard counts still follow 0129's per-file targets; tune them from recorded run
durations rather than raising caps on guesses. Jobs share the organization's
concurrent-job limit for GitHub-hosted runners, so overlapping runs can queue.
`actions/cache` uses GitHub's per-repository cache (10 GB, oldest entries
evicted).
