# 0163 — Production databases through the gateway, with reviewed queries

- **Status:** Accepted
- **Date:** 2026-09-25
- **Refines:** 0162

## Context

Company brain work (support investigations, pilot reporting, security reviews)
needs to read production data. Giving agents a connection string puts the
credential in a sandbox and lets one careless or injected query slow the
database or read what it should not. The company also wants every query
reviewed, possibly by a classifier model, before it runs.

## Decision

**A database is a gateway connection.** The Postgres connection kind stores the
connection string of a dedicated read-only role in the vault. Authorization
refuses superusers, roles that can create roles or databases or bypass row
security, table owners, and roles holding any write privilege. Its actions are
`query`, `explain`, and `schema`; `query` asks the caller to state a purpose.

**Postgres enforces the hard rules, not a SQL parser.** Each call opens a
read-only transaction with statement and lock timeouts, sends the SQL through
the extended protocol (exactly one statement), checks the planner's estimate
against cost and row ceilings before running, and reads through a cursor that
fetches a bounded number of rows within a byte budget. A readable pre-check
refuses non-read statements early. We add no parser dependency; the database's
own parser, read-only mode, and role grants are the boundary. Operators should
point the connection at a replica with views that omit sensitive columns.

**Review is policy, configured beside the connection.** `WORK_GATEWAY_CONFIG`
declares connections (MCP endpoints, HTTP APIs, databases) and guards. A model
guard sends the action, the stated purpose, and the requester to any AI SDK
model or OpenAI-compatible classifier endpoint with a written policy, treating
the request as quoted data. It answers allow, deny, or escalate; a malformed
answer or model error refuses and a slow model escalates. An approval guard
sends matching actions to a person. Model keys are named by environment
variable, never written in the file.

Considered: parsing SQL with a bundled Postgres parser to allowlist statement
shapes. It adds a native or WASM dependency while the database already refuses
writes, stacked statements, and runaway work more reliably.

## Consequences

Agents can investigate production data without holding credentials, every
query is reviewed and audited, and expensive queries fail with a message that
tells the agent how to narrow them. Result rows enter model context, so views
and role grants remain the way to keep personal data out. Workflows reading
production data must use queries the guards allow unattended.
