# 0316: Members' own agents use connections; hosts route custody

- **Status:** Accepted (amends 0065, 0166, 0172; builds on 0315)
- **Date:** 2026-11-14

## Context

A company wants one Work MCP in each employee's own agent (Claude Code on
their machine): the project's tools, each person's own accounts connected
when first needed, company policy checked on every call, and credentials
kept by the company's own systems. ADR 0166 sent members to production
systems only through `ask_agent`. Bindings could accept either a member's
or a service account, so one alias could act as two identities. Providers
were told nothing about who a call was for, the vault nothing about what it
stored, and concurrent refreshes spent single-use refresh tokens twice.

## Decision

**Members' own agents call connections over the project MCP.** Without a
Work session, the endpoint lists each alias the member may use in its
Environment (`?environment=`, else the project default) as native tools,
`<alias>__<action>`, with the upstream schemas and annotations, and MCP
results unchanged (ADR 0225). Calls go through the broker's ordinary guards
and audit with a third caller kind, `member`, and no Allocation: authority
resolves live on every call, so detaching, revoking or narrowing a role
applies at once (the member is re-resolved after guards, too). Escalations
are refused. A role that grants only connections opens the endpoint for
those connections and nothing else of the project.

**Connecting is a browser step bound to the person.** An alias the member
has not connected offers `<alias>__connect`, which returns a single-use
link (`connections.offerConnection`, hash stored, 15 minutes). The host's
page (`projectMcp.connectLink`) requires a browser signed in as that member,
redeems the link, and keeps a browser binding in an HTTP-only cookie named
for that attempt (`connectBindingCookie`: `__Host-` prefixed unless the
public address is loopback); the attempt completes only with it, and a
callback without it ends the attempt. A forwarded link, or a forwarded upstream consent page, connects
nothing. Device codes are refused for links: anyone handed the code could
consent. Attempts started through the older authorize API (the desktop and
PWA) are not browser-bound; they remain as phishable as before and should
move to this flow.

**An alias acts with one authority.** A binding's `principal` is `member` or
`service`; `either` is removed, as is a requirement's own `principal`. A
project that wants both declares two aliases.

**Core tells host code what it handles.** Every vault write carries a
trusted `placement` (purpose, owner, project); `routeCredentialVaults`
composes vaults by host logic and keeps each ref on the vault that wrote it.
Every action call (`invoke`, `listActions`, `refresh`, `revoke`) carries a
`ConnectionCallContext` (tenant, connection, principal, project,
Environment, alias, and the live acting member, never a grant id), so a
provider can mint or fetch its credential per call. A provider that
declares `keepsNoCredential` is stored with nothing at all; empty material
from any other provider is an error. Gateway protocol routes (Git, model,
HTTP from sandboxes) forward stored credentials, so such providers cannot
serve them. A host vault, or `routeCredentialVaults` with a `fallback` for
records written before routing, keeps the rest outside Work.

**Refresh is serialized.** A per-connection lease with a holder token in
Postgres lets one caller on any replica exchange a refresh token; the
exchange is abandoned before the lease can lapse, a taken-over holder can
neither publish nor expire the connection, and waiting callers take over a
lease its holder dropped or let lapse. Admission and snapshot revalidation
refresh before judging expiry; revoked or expired connections are never
refreshed, and revocation releases the credential stored when it locks the
row. A refresh that cannot run now (the provider unreachable, another
replica still refreshing) fails only that call: a token with time left is
still used, and nothing is suspended, parked, or sent to reconnect.

Considered: generic `discover`/`invoke` tools instead of native ones.
Rejected: clients lose per-tool permissions, annotations and typed results.
Considered: URL elicitation (`-32042`). Deferred: the endpoint is stateless
and cannot know a client's capabilities on a call; a link in the tool
result works with every client.

## Consequences

Employees configure one URL per project. Vendor setup stays in skills and
host providers. Hosts must serve the connect page; without `connectLink`,
connect tools ask people to connect in Work. Code-host origin selection
(remote sync, pull requests) keeps its own member-then-service choice; it
is not a committed binding.
