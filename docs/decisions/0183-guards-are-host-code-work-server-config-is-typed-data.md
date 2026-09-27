# 0183 — Guards are host code; Work server config is typed data

- **Status:** Accepted
- **Date:** 2026-09-27
- **Amends:** 0160, 0162, 0163

## Context

ADR 0163 put review policy in the gateway file: `WORK_GATEWAY_CONFIG` held a
`guards` array whose entries had `type: "model"` (a classifier with a written
policy, a provider, and a key variable) or `type: "approval"`, and the Work
server shipped `defineModelGuard` and `defineApprovalGuard` to run them. What a
company allows on its systems is its doctrine (ADR 0049), and typed guard kinds
in JSON are a policy format we invented, which AGENTS.md rules out ("we never
invent DSLs or JSON formats"). Each new kind of review would have grown that
format.

The same review found the config boundary blurred. `WorkServerConfig` carried
`authConfigPath`, and `createWorkServer` read `<dataDir>/auth-config.json` at
boot, so a custom server could not hand over sign-in configuration as data.
Gateway entries named secrets by environment variable (`secretEnv`), and the
Google Workspace directory accepted its key only as a file.

## Decision

**Guards are host code.** Core keeps the generic `ConnectionActionGuard`
(`name`, optional `kinds`, `review(context)` answering allow, deny, or
escalate) and every mechanic around it: guards run on every brokered action, a
throwing guard denies, a guard slower than the timeout escalates (now
configurable: `connectionGuardTimeoutMs` in core and server-sdk, and in
`WorkServerConfig`, default 30 seconds), escalations reach the agent's person
or a project chat's approvers (ADR 0176), and each verdict is audited. `kinds`
stays, so guards skip connections they do not judge. Work ships no guard
implementations, no guard types, and no classifier helper. The `guards` array
of the gateway file is gone; hosts pass guards as
`createWorkServer({ hooks: { connectionGuards } })` or
`createCatamorphic({ connectionGuards })`. The stock image runs without guards,
and an operator who wants one writes a short custom server (the ADR 0160
shape); the setup skill carries examples: a model classifier that treats the
request as quoted data, an always-escalate guard, and a SQL column denylist.

Mechanics stay native: connection providers (Postgres, HTTP, Git, model,
MCP), Postgres limits, Git push rules, and model allowlists and budgets.

This amends 0163's "review is policy, configured beside the connection": the
database's own rules remain the boundary, and query review, where a company
wants it, is its code. It amends 0162 only in that the gateway ships no
reviewers.

**Work server config is typed data; files are only the image's input.**
`config` is typed, serializable data validated at boot by the same Zod schemas
as the files (`WorkAuthConfigSchema`, `GatewayConfigSchema`); `hooks` are
code; only `workServerConfigFromEnv` knows `WORK_*` variables and file paths.
`config.auth` replaces `authConfigPath`: the environment layer reads
`WORK_AUTH_CONFIG` (default `<WORK_DATA_DIR>/auth-config.json`, absent meaning
local sign-in) into it, and `createWorkServer` reads no configuration file.
`config.gateway` carries resolved values (an MCP client's `secret`); the file
keeps `secretEnv`, which the environment layer resolves. A Google Workspace
directory also accepts its key inline (`{ key }`, the JSON as an object or a
string). Generated state (the vault key file, generated secrets, the host id,
worker credentials) stays in files under the data directory.

Considered: keeping the two guard kinds as convenient defaults. Rejected:
they fix one shape of policy and prompt in the framework, and a guard is ten
lines of host code.

## Consequences

The image's gateway file and sign-in file keep working unchanged, except that
a `guards` entry now fails validation. Companies that relied on file guards
move them into a custom server. Custom servers can source every secret from a
secret manager without writing files. Hosts other than the Work server gain
the configurable guard timeout.
