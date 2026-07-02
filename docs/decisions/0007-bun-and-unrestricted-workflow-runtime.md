# 0007 — Bun runtime; workflows run as regular, unrestricted code

- **Status:** Accepted
- **Date:** 2026-07-02

## Context

Many workflow engines execute user code in restricted JS runtimes (no IO, no npm packages, tight sandboxes at the language level). That breaks the "workflows are regular apps" promise: users couldn't call databases, use SDKs, or install dependencies.

## Decision

User-defined workflow/app code runs as **regular code with full IO and real npm dependencies**. Isolation comes from the **sandbox boundary** (a VM per deployment — ADR 0004), not from crippling the language runtime.

**Bun** is the runtime everywhere it fits: monorepo package manager and script runner, execution runtime inside sandboxes (`bun run harness.ts`), and bundler where bundling is needed. Fast startup matters for ephemeral sandboxes.

## Consequences

- Workflow authors (and AI agents) can use any npm package and any IO — nothing to special-case.
- Security is entirely the sandbox's job; never execute user code in the host/server process.
- The runtime harness (`packages/runtime`) must stay Bun-compatible; sandbox images ship Bun.
