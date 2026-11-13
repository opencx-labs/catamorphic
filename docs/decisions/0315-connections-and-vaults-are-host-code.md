# 0315: Connections and vaults are host code

- **Status:** Accepted (amends 0162, 0183)
- **Date:** 2026-11-14

## Context

ADR 0183 made guards host code but kept connections as data: a Work server
read `WORK_GATEWAY_CONFIG` into `config.gateway`, validated by
`GatewayConfigSchema`, with entry types (`http`, `postgres`, `git`, `model`,
`mcp`) that `gatewayProviders` turned into providers. That schema was a
small connection language we invented, and every new vendor or option grew
it. Since ADR 0294 every deployment owns a TypeScript entry point, so the
file only duplicated what the provider helpers already express.

Credential storage had the same shape. ADR 0162 seals credentials in Work's
own encrypted vault; a host could supply keys (`vaultKeys`) but not the
vault, so a company with a secret manager still had its credentials stored
inside Work.

## Decision

**Connections are only host-passed provider code.** `createWorkServer`
brokers the built-in GitHub and model providers plus
`hooks.connectionProviders`. The helpers
(`defineHttpApiConnectionProvider`, `definePostgresConnectionProvider`,
`defineModelConnectionProvider`, `defineGitConnectionProvider`,
`defineMcpConnectionProvider`) are functions, not a config language: hosts
call them or write their own provider. `config.gateway`,
`GatewayConfigSchema`, the file parser and `WORK_GATEWAY_CONFIG` are
removed. The ceilings the schema enforced (HTTP response size and timeout,
Postgres rows, timeouts and pool size, HTTP path shape) are enforced by the
helpers themselves. A host provider exposing `close()` is closed at
shutdown. `defineMcpConnectionProvider` returns JSON-typed results so it
passes as a `ConnectionProvider` without an adapter.

**A host may replace the vault entirely.** `hooks.credentialVault` takes
any `CredentialVault`. Work then uses it for every stored credential,
writes no vault key or credentials directory, records no key ids, and
refuses to boot if vault keys are also supplied: the host's vault owns its
key custody. Work never requires that secrets be stored inside it; its own
encrypted vault remains the default.

**Vendor recipes belong in skills.** How to connect Slack, OpenRouter or a
read replica is guidance in the setup skill, written as provider calls.

Considered: keeping the file as an optional convenience for the reference
server. Rejected: two ways to declare a connection, and the file would keep
growing as a vendor-neutral DSL.

## Consequences

Deployments that used `WORK_GATEWAY_CONFIG` move its entries into their
entry point, one helper call each; MCP client secrets come from the host's
own secret source instead of `secretEnv`. Every replica must run the same
entry point to offer the same providers. Hosts may keep credentials in
their own secret manager without any record inside Work.
