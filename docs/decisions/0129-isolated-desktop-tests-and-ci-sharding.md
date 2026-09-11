# 0129 - Isolated desktop tests and CI sharding

- **Status:** Accepted
- **Date:** 2026-09-11

## Context

Desktop tests share the developer's macOS session and can interrupt typing.
Transparent, non-focusable windows and emulated page focus neither isolate
the desktop nor exercise normal native behavior. The last successful CI run
spent nearly 12 of its 18 minutes running desktop suites serially.

## Decision

Local desktop E2E commands run real Electron in Docker with a private Xvfb
display and Openbox window manager. A filtered source snapshot includes local
edits, with Linux dependencies installed inside the image. No host display,
clipboard, home directory, credentials, or Docker socket enters the container.
Missing isolation fails before Electron launches; there is no local fallback.
All desktop suites run with normal shown, focusable windows. Remove the
hidden/visible split and focus emulation. Native macOS coverage runs on
dedicated GitHub-hosted macOS CI runners, never a developer's GUI session.

Use the organization's existing Blacksmith Ubuntu runner family for Linux CI.
Run validation, workspace tests, PWA E2E, and desktop E2E as independent jobs.
Shard Vitest by whole file across runners, preserving ordered tests and one
Electron suite per display. Each workspace shard owns its disposable Postgres.
A stable aggregate check requires every lane and shard to succeed. Cache
dependencies/build outputs, never test successes or databases across shards.
Build each package before testing its own exports. Stock-server tests use
separate Node processes for PGlite to avoid shared V8 JIT allocation crashes;
other workspace tests retain worker threads and the same concurrency limits.

Before matrix expansion, discover files through each workspace's Vitest config
(or the shared root config) and the desktop E2E config, without importing tests.
Compute shard counts each run: one per 100 workspace files, 5 Linux desktop
files, or 10 macOS desktop files. Use at least one shard and cap these lanes at
16, 32, and 16 runners respectively. Counts grow automatically within those
budgets; keep Vitest's file partitioning rather than adding a timing service.

A local macOS VM was rejected because of its large initial download. Linux
tests do not replace macOS-specific coverage. Increasing Electron workers on
one display was rejected because real focus would race between app instances.

## Consequences

Local tests need Docker and a cached Linux image, but no macOS guest download.
CI gains independent displays and more concurrency at the cost of repeated
setup and runner minutes. Native macOS results require CI; graphics timing
still depends on the runner. File counts approximate work; a growing individual
file does not add shards. Tune targets and caps using recorded run durations,
not by reducing coverage or weakening assertions.
