# Remote Server Experience Implementation Sequence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Catamorphic's token-link remote flow with host-owned authentication, agent-driven server setup, recoverable one-remote project bindings, builder-aware checkout, and actionable connection UX.

**Architecture:** Work proceeds through six dependency-ordered replacements. Each sub-plan leaves the monorepo usable. A replacement may prepare its new foundation before cutover, but it does not expose a second user path or add compatibility code; the old contract is deleted atomically when the replacement is complete. No legacy connect links, token files, compatibility adapters, or parallel GitHub paths survive the sequence.

**Tech Stack:** TypeScript, Bun, Better Auth, Kysely, Postgres and PGlite, Fastify, Zod/OpenAPI, OAuth 2.1 and PKCE, Electron, React, GitHub REST and git, MCP authorization, Vitest, and Electron E2E.

**Spec:** `docs/superpowers/specs/2026-08-26-remote-server-auth-and-connection-design.md`

## Global Constraints

- One project has zero or one Catamorphic remote; Environments live beneath it.
- Catamorphic libraries remain auth-provider-neutral and host-injectable.
- The stock server has no owner/super-admin identity, setup wizard, or admin UI.
- Setup skills inspect and adapt to the user's existing app, auth, database, and deployment.
- Local provisioning remains one Better Auth user-creation call plus membership assignment or is removed.
- No token-bearing connect links, `auth.json`, legacy link migration, or dual-write persistence survives.
- GitHub CLI is a credential source only; all behavior after acquisition uses the shared GitHub and git services.
- User-facing copy contains no em dashes or en dashes.
- Do not run `git add`, `git commit`, or `git push` without explicit user approval.
- Preserve unrelated working-tree changes and edit overlapping files by focused hunk only.

## Ordered sub-plans

1. `2026-08-26-stock-auth-and-agent-setup.md`
   - Use the completed PGlite and Postgres feasibility proof as the local-auth
     complexity gate.
   - Add the stock Better Auth host adapter, local provisioning primitive,
     adaptive setup skill, Docker discovery, and existing-host auth guidance.
   - Leave the current remote token path untouched and unextended until the
   following cutover so intermediate commits remain usable without exposing
   two connection experiences.
   - Status: implemented and focused verification complete.
2. `2026-08-26-remote-oauth-and-admission.md`
   - Add OAuth/OIDC discovery, PKCE desktop authorization, access/refresh
     verification, project invitations, admission policies, and role-based
     membership-management permissions.
   - Replace token-bearing connect and renew links completely, then delete
     `auth.json`, printed admin tokens, and admin-token routes in this cutover.
3. `2026-08-26-project-remote-binding-and-health.md`
   - Add the gitignored project-local locator, stable encrypted credential
     binding, connection health state machine, retry classification, and
     reconnect-in-place behavior.
   - Delete local-project-id-only remote persistence.
4. `2026-08-26-builder-checkout-and-github-credentials.md`
   - Advertise code-host checkout metadata, reuse validated `gh` credentials,
     fall back to GitHub authorization, and route builder clones through the
     existing `GithubService` and git engine.
   - Keep scoped document materialization for non-builders.
5. `2026-08-26-desktop-remote-connection-ux.md`
   - Add project-selector status, connection popover, adaptive palette action,
     actionable composer errors, and visible mirror-paused recovery.
   - Record the approved interaction in `apps/desktop/DESIGN.md` and verify it
     visually in the desktop host.
6. `2026-08-26-server-entry-and-mcp-onboarding.md`
   - Add the lightweight signed-in server entry surface, desktop download/open
     guidance, discoverable-project joining, and standards-based MCP OAuth
     onboarding without browser project execution.
   - Finish public skill and `catamorphic.ai` discovery documentation.

Do not start a later sub-plan until focused tests and applicable repository
checks for the previous replacement pass. Detailed sub-plans are written
immediately before their slice so their interfaces reflect the code that
actually landed.

## Initial completed work

- [x] Default projects with no manifest Environment declaration to the
      desktop's local Environment (`2fae9e7`).
- [x] Agree that a project has one optional remote and all execution targets
      beneath it are Environments.
- [x] Agree on host-owned auth, stock Better Auth, agent-driven setup, local
      credential fallback, OAuth PKCE, recoverable project locator, GitHub CLI
      credential reuse, and the desktop status/reconnect experience.
- [x] Prove Better Auth migration, local-user creation, and username sign-in
      against both PGlite and regular Postgres without repository changes.

## Final verification

- [ ] Run `bun run lint` and require zero warnings and errors.
- [ ] Run `bun run typecheck` and require every Turbo package to pass.
- [ ] Run `bun run build` so every changed package is consumed through `dist`.
- [ ] Run `bun run test` and require all package suites to pass.
- [ ] Run `bun run db:migrate && bun run db:codegen` and confirm generated
      database types are synchronized.
- [ ] Generate the Fastify OpenAPI spec and API client, then require a clean
      second generation.
- [ ] Run the complete desktop checklist from `apps/desktop/AGENTS.md`,
      including hidden and visible E2E suites.
- [ ] Run stock-server Docker E2E against both local credentials and a fake
      OAuth provider.
- [ ] Verify MCP authorization discovery with a real discovery-capable client.
- [ ] Launch the desktop host and visually verify healthy, offline,
      authentication-required, revoked, and missing-project states with zero
      renderer or main-process console errors.
- [ ] Run `git diff --check` and inspect `git status --short`; do not stage or
      commit without explicit approval.
