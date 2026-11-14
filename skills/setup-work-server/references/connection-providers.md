# Connection providers in the server's code

Use this when a Work server should broker a system that the built-in helpers
do not fit as they are: credentials issued per call, secrets kept in the
company's own manager, per-person access the company decides, or an MCP server
reached through company logic. A provider is ordinary TypeScript the
deployment's entry point passes in `hooks.connectionProviders` (ADRs 0315,
0316). There is no configuration format; write code, and put any recipe for a
specific vendor in a project or server skill, not in Work.

Start from a helper when one fits (`defineHttpApiConnectionProvider`,
`definePostgresConnectionProvider`, `defineModelConnectionProvider`,
`defineGitConnectionProvider` from `@catamorphic/server-sdk`,
`defineMcpConnectionProvider` from `@catamorphic/mcp`), and wrap it or write
your own when it does not. The contract is `ConnectionProvider` in
`packages/core/src/services/connection-providers.ts`; read it there.

## The contract in brief

- `kind` and `displayName` name the provider. Environments bind aliases to a
  `kind` in `.work/project.json`; each alias is `principal: "member"` (each
  person's own account) or `"service"` (one named service connection), never
  both.
- `beginAuthorization` / `completeAuthorization` run when someone connects:
  a URL challenge (OAuth, returning to `<public origin>/api/connection-authorizations/callback`),
  a form, or a device code. They return `material` to keep, the
  `capabilities` (action names) the connection allows, and optional expiry.
- `listActions({ material, context, capabilities })` describes the actions as
  tools; `invoke({ material, context, action, input, ... })` performs one.
  `refresh` renews expiring material; `revoke` withdraws it upstream.
- Every action call gets `context`: tenant, connection, principal (member id
  or service name), project, Environment, alias, and `externalUserId`, the
  live person the call acts for. Core derives it; tool arguments never can.
  Authorize per person with it, mint per-call credentials with it, tag your
  upstream audit with it.
- Only actions listed in the connection's `capabilities` (narrowed by the
  binding and the person's role) can be called. Keep that list a fixed set of
  action names; put variable things, such as which account or tenant, in the
  action's input.
- `readOnly(action)` (or `readOnlyHint` annotations) marks actions a contained
  agent may call. `mcp: true` passes an MCP server's tool results through
  unchanged.

## Keeping credentials out of Work

- To store material somewhere other than Work's vault, pass
  `hooks.credentialVault`; to use several stores, compose them with
  `routeCredentialVaults` ([secrets and the gateway](secrets-and-gateway.md)).
- To store nothing, declare `keepsNoCredential: true` and return
  `material: new Uint8Array(0)` from `completeAuthorization`. Fetch or issue
  the credential inside `invoke`, `listActions` and the rest from `context`
  and your own secret manager or token service. Such a provider cannot also
  define `git`, `model` or `http`, whose gateway routes forward a stored
  credential. Empty material from any other provider is an error.
- Refresh failures that never reached the provider (network errors, 5xx) are
  temporary: the call fails and can be retried, and nothing is suspended or
  sent to reconnect. Throw the provider's refusal (an OAuth `invalid_grant`)
  as an ordinary error so the person is asked to connect again.

## Pattern: per-person access to many accounts

A company with one credential per customer account (or tenant, region,
workspace) wants each engineer to reach only the accounts they own or were
granted, from one project MCP. Build it as one alias, not one per account:

1. **One service connection.** Bind an alias, for example `accounts`, with
   `principal: "service"` and a service connection an administrator
   authorizes once. Grant the alias to the team's role.
2. **A provider that keeps no credential.** `listActions` returns the
   upstream tools with an `account` input whose `enum` lists the accounts
   `context.externalUserId` may use now. `invoke` checks the requested account
   against the same function, fetches that account's token from the company's
   secret manager, calls the upstream (an account's own MCP server, through
   the `@catamorphic/mcp` client, or its API), and returns the result.
3. **Who may use what is one company function**: the accounts a person owns
   (from the CRM or an ownership table) plus unexpired grants. Ownership needs
   no request; a change applies on the next call, and so does removal.
4. **Requesting access is a workflow.** An `ai.tool-call` workflow such as
   `request_account_access({ account, reason, hours })` runs as the caller and
   returns a `host` call (`defineCapability` with `calls`, passed in
   `hooks.capabilityProviders`) that records the grant with its expiry in the
   company's own Postgres. Work stamps the caller on the call; never take
   identity from the workflow's input. Add an owner's sign-off with a
   workflow that waits, if the company wants one.
5. **Audit**: every call is in Work's connection audit with actor and action;
   log the account in the provider as well.

Keep the account an argument: per-account tool names would need actions the
fixed capability list cannot name. Tool lists are cached by clients until
they reconnect, but because the provider checks every call, a newly granted
account works before the list refreshes.

## Members' own agents

The Work server serves granted aliases to members' own agents as
`<alias>__<action>` tools on the project MCP, and an unconnected member alias
as `<alias>__connect`, which returns a link only that person's signed-in
browser can complete ([working from your own agent](members-over-mcp.md)).
A custom host built on the Fastify plugin opts in with
`projectMcp.memberConnections`, serves a connect page through
`projectMcp.connectLink`, and sets `publicApiBase` (see `INTEGRATION.md`).

## Verify

Test a provider in process: construct it, call `listActions` and `invoke`
with a `context` for two different people, and assert each sees and reaches
only their own accounts. Then bind it in a project, call it from the project
MCP as two members, and remove a grant between calls. The core suite
`packages/core/src/__tests__/host-owned-connections.integration.test.ts`
shows these checks against a real broker.
