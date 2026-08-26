# Remote OAuth and Admission Cutover Plan

> **For agentic workers:** Use `superpowers:test-driven-development` for each
> behavior and `superpowers:verification-before-completion` before reporting
> this replacement complete. Execute inline in the current task. Do not expose
> the new public path until all stock clients use it and the legacy path can be
> deleted in the same working change.

**Goal:** Replace stock-server token files and token-bearing connection links
with browser sign-in, OAuth authorization code plus PKCE, refreshable client
credentials, ordinary project administration permissions, and explicit
project admission.

**Architecture:** Better Auth remains private to `apps/server`. Its configured
local or upstream OIDC sign-in establishes one Better Auth user. Better Auth's
OAuth provider endpoints then issue the same access and refresh credential
shape to desktop, PWA, and MCP clients. The stock identity resolver validates
the OAuth access token and asks core to expand every membership for the stable
Better Auth user id. Authentication never carries project authorization.
Project membership, admission, and committed role definitions provide that
authorization. A stock-only admission service stores invitations and host
admission policy while core enforces project administration permissions.

**Greenfield cutover:** There is no migration or compatibility path for
`auth.json`, invite access tokens, old remote project records, or old connect
links. Tests and callers change first inside this working change, then those
implementations are deleted before the slice is considered usable.

**Tech Stack:** TypeScript, Bun, Better Auth 1.6, OAuth 2.1 authorization code
with PKCE, OIDC discovery, Fastify, Zod, Kysely, PGlite/Postgres, Electron,
React, Vitest, Electron E2E.

**Design:**
`docs/superpowers/specs/2026-08-26-remote-server-auth-and-connection-design.md`

## Task 1: Record the authorization and admission boundary

**Files:**

- Create: `docs/decisions/0072-remote-oauth-admission-and-project-administration.md`
- Modify: `docs/decisions/README.md`

- [ ] Record one OAuth authorization server for desktop, PWA, and MCP;
      upstream providers are login methods only.
- [ ] Record that access tokens resolve a user, never a project or role, and
      core expands all current memberships on every request.
- [ ] Record separate `memberships:manage` and `roles:manage` project
      permissions. Builder access does not imply either permission.
- [ ] Record the protected-role rule: assigning a role which grants project
      administration, or changing role files, requires `roles:manage`.
- [ ] Record invitation-only, approved-domain, request, and open-authenticated
      admission modes as stock-host policy, not Better Auth state.

## Task 2: Add project administration permissions test-first

**Files:**

- Modify: `packages/core/src/identity.ts`
- Modify: `packages/core/src/services/roles-service.ts`
- Modify: `packages/core/src/services/memberships-service.ts`
- Modify: `packages/core/src/services/documents-service.ts`
- Modify: `packages/core/src/services/deployment-service.ts`
- Modify: role, membership, document, and deployment tests
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: generated OpenAPI and API client outputs

- [ ] Write failing role tests for `permissions: ["memberships:manage"]` and
      `permissions: ["roles:manage"]` expanding into project permission refs.
- [ ] Add project permissions to `Identity` as a narrowing scope separate from
      artifact, Environment, connection, and host control-plane permissions.
- [ ] Change membership list/grant/revoke authorization from builder to
      `memberships:manage`; retain self-read.
- [ ] Before assigning roles, load their definitions. Require `roles:manage`
      if any assigned role contains a project administration permission.
- [ ] Reject writes, deletions, deployments, or proposal application touching
      `roles/*.json` unless the caller has `roles:manage`, even when they are a
      builder. Keep direct setup-agent service identities able to perform the
      initial operation.
- [ ] Update DTO schemas and generated clients only after focused service and
      route tests pass.

## Task 3: Resolve one authenticated user across all memberships

**Files:**

- Modify: `packages/core/src/services/memberships-service.ts`
- Modify: `packages/core/src/services/memberships-service.test.ts`
- Modify: `packages/core/src/services/roles-service.ts`

- [ ] Write a failing test in which one external user has different roles in
      two projects and receives the deduplicated union of artifact,
      Environment, connection, and project-permission scopes.
- [ ] Implement `identityForUser({ tenantId, externalUserId })` as a fresh
      membership read plus per-project role expansion. Unknown users receive a
      valid empty scoped identity, not a root identity and not authentication
      failure.
- [ ] Keep `identityFor({ projectId, ... })` for hosts that resolve one
      project at a time.

## Task 4: Configure stock login methods adaptively

**Files:**

- Create: `apps/server/src/auth/auth-config.ts`
- Create: `apps/server/src/auth/auth-config.test.ts`
- Modify: `apps/server/src/auth/stock-auth.ts`
- Modify: `apps/server/src/auth/stock-auth.test.ts`
- Modify: `apps/server/README.md`
- Modify: `skills/setup-catamorphic-server/references/stock-server.md`
- Modify: `skills/setup-catamorphic-server/references/auth-and-identity.md`

- [ ] Define and validate a stock auth configuration file whose default is
      local username/password and whose external entries use OIDC discovery,
      client credentials, scopes, and optional verified-email domains.
- [ ] Keep deployment mechanics adaptable: the config path is injectable and
      agents may populate it from an existing secret manager, mounted file, or
      deployment environment. Do not prescribe one secret transport.
- [ ] Configure every external entry through Better Auth's generic OIDC path.
      Google Workspace is configuration of that path, not a Catamorphic code
      branch.
- [ ] Disable implicit provider sign-up when admission policy requires an
      invitation or request. A verified login may exist without project
      membership.
- [ ] Expose the configured login methods to the stock entry page without
      exposing provider secrets.

## Task 5: Mount OAuth, login, and discovery routes

**Files:**

- Create: `apps/server/src/auth/fastify-auth.ts`
- Create: `apps/server/src/auth/fastify-auth.test.ts`
- Modify: `apps/server/src/auth/stock-auth.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/server.test.ts`

- [ ] Add Better Auth's OAuth/MCP provider plugin with dynamic public client
      registration, authorization code, refresh token, `offline_access`, and
      required S256 PKCE.
- [ ] Mount the Better Auth handler through one Fastify bridge under
      `/api/auth/*`, preserving status, multi-value cookies, redirects, and
      request bodies.
- [ ] Expose authorization-server and protected-resource discovery at the
      standard well-known locations clients probe, as aliases to the same
      provider metadata.
- [ ] Add lightweight login and consent routes used only during browser auth.
      Local login and each configured external provider establish the same
      Better Auth session. The consent surface names the requesting client and
      requested scopes.
- [ ] Add a `StockAuth.resolveAccessToken` operation backed by the OAuth
      provider access-token store. Do not accept Better Auth browser session
      cookies as API bearer credentials.
- [ ] Replace the Catamorphic HTTP identity resolver with access-token
      verification plus `core.memberships.identityForUser`.
- [ ] Send standards-based `WWW-Authenticate` protected-resource metadata on
      missing, invalid, and expired API bearer credentials.

## Task 6: Add stock admission and invitation policy

**Files:**

- Create: `packages/db/migrations/063_stock_project_admission.sql`
- Modify: `packages/db/src/generated/db.ts`
- Create: `apps/server/src/admission/admission-service.ts`
- Create: `apps/server/src/admission/admission-service.test.ts`
- Create: `apps/server/src/admission/routes.ts`
- Create: `apps/server/src/admission/routes.test.ts`
- Modify: `apps/server/src/server.ts`

- [ ] Store project admission mode, default role, approved verified-email
      domains, invitations, and access requests without storing auth tokens.
- [ ] Invitation links identify an invitation and project but never authorize
      an API request. Redemption requires an authenticated Better Auth user
      matching the invitation identity when one was specified.
- [ ] Enforce the four approved modes: invitation only, approved domain,
      authenticated request, and open authenticated join.
- [ ] Validate the default or explicitly invited role files before granting a
      membership. Never invent a role or silently widen access.
- [ ] Authorize invitation creation, request decisions, and membership changes
      with ordinary project permissions. No route accepts an operator
      credential or server-admin user token.
- [ ] Keep the machine-local provisioning route for initial setup only. It may
      establish the first ordinary role-bearing user through its existing
      operational identity.

## Task 7: Replace the desktop token link with OAuth PKCE

**Files:**

- Modify: `apps/desktop/src/main/connect-link.ts`
- Create: `apps/desktop/src/main/remote-oauth.ts`
- Create: `apps/desktop/src/main/remote-oauth.test.ts`
- Modify: `apps/desktop/src/main/remote-projects-store.ts`
- Modify: `apps/desktop/src/main/remote-http-client.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/renderer/lib/desktop-api.ts`
- Modify: `apps/desktop/src/renderer/components/remote-connect-modal.tsx`
- Modify: desktop remote tests and E2E

- [ ] Parse links containing only server URL, optional project id, display
      name, and invitation id. Reject every credential-bearing link shape.
- [ ] Discover metadata, dynamically register a public native client, create
      state and an S256 PKCE verifier, open the system browser, and receive the
      callback on an ephemeral loopback listener.
- [ ] Exchange the code in the main process. Encrypt access token, refresh
      token, client id, and expiry in the profile store under one connection
      credential record.
- [ ] Add one token supplier used by documents, sync, mirroring, sessions, and
      all other remote HTTP calls. It refreshes once before expiry and retries
      one request after an expired-token response.
- [ ] Connect only after login, admission, and project selection succeed.
      Reconnect reuses the stored server and project rather than asking for
      them again.

## Task 8: Replace PWA profiles and mobile pairing credentials

**Files:**

- Modify: `apps/pwa/src/lib/connect-link.ts`
- Modify: `apps/pwa/src/lib/store.ts`
- Modify: `apps/pwa/src/lib/api.ts`
- Modify: `apps/pwa/src/screens/connect-screen.tsx`
- Modify: PWA unit and stock-server E2E tests
- Modify: `apps/desktop/src/main/mobile-pairing.ts`
- Modify: desktop mobile-pairing E2E

- [ ] Use browser PKCE against the same discovered authorization server and
      store refreshable credentials in the PWA profile.
- [ ] Remove token query parsing, token-bearing URLs, and paste-a-token copy.
- [ ] Refresh through the same token endpoint semantics as desktop.
- [ ] Mobile pairing may transfer a remote locator but never transfers a
      person's server access or refresh token. The phone signs in as itself.
- [ ] Preserve desktop-LAN device pairing as a separate local device-token
      mechanism because it authenticates the desktop proxy, not a remote
      Catamorphic server.

## Task 9: Delete the legacy stock identity path

**Files:**

- Delete: `apps/server/src/auth-store.ts`
- Delete: `apps/server/src/auth-store.test.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/index.ts`
- Modify: stock, desktop, PWA documentation and tests

- [ ] Delete `AuthStore`, `auth.json`, admin token creation and printing,
      `/admin/*` bearer authorization, token revoke routes, `TokenRecord`, and
      token-link builders.
- [ ] Replace operator project creation examples with the adaptive setup skill
      and machine-local setup operation. The machine credential remains
      operational authority and is never accepted on application routes.
- [ ] Search the repository for legacy token query fields, renew links,
      printed admin-token copy, and auth-file reads. Remove all product paths;
      retain unrelated provider tokens such as model or GitHub credentials.

## Task 10: Verify the atomic replacement

- [ ] Run focused core role and membership tests.
- [ ] Run focused stock auth, admission, route, restart, and Docker tests for
      local login and a fake OIDC provider.
- [ ] Run Fastify spec generation and API-client generation twice; require a
      clean second output.
- [ ] Run desktop unit, hidden E2E, and visible E2E checks.
- [ ] Run PWA unit and stock-server E2E checks.
- [ ] Run `bun run db:migrate && bun run db:codegen`.
- [ ] Run root lint, typecheck, build, and tests. If an existing credentialed
      integration cannot run safely, document the exact pre-existing blocker
      and run all local affected suites.
- [ ] Build and run the stock Docker image, authorize a public PKCE client,
      refresh its token, restart, and verify the same user memberships.
- [ ] Probe protected-resource and authorization-server discovery with an MCP
      client or protocol-level conformance test.
- [ ] Run `git diff --check` and inspect `git status --short`, preserving all
      unrelated user work. Do not commit without explicit user approval.

## Handoff

After this cutover, write
`2026-08-26-project-remote-binding-and-health.md`. It may assume every remote
credential has stable access/refresh semantics and no legacy token link or
`auth.json` exists.
