# 0261: A connection offers its provider's actions

- **Status:** Accepted (amends 0172)
- **Date:** 2026-10-18

## Context

A connection records the capabilities its authorization returned, and
bindings and roles narrow that list (ADR 0172). Every built-in provider
(GitHub, HTTP, Postgres, model, Git) returns its whole action list, the same
for every authorization. So a connection keeps the list from the day it was
authorized: when a release adds GitHub actions (the review poster's typed
writes, ADR 0259) or an operator adds an HTTP action to `WORK_GATEWAY_CONFIG`,
existing connections never offer them, and a binding that names them gets
less than it asks for, quietly, until someone authorizes again.

## Decision

**A provider may declare its actions.** `ConnectionProvider.capabilities`
lists every action the provider offers when they do not depend on what an
authorization granted. A connection of that provider offers this list, read
when it is used, not the one its authorization recorded; bindings and roles
narrow it as before, and the connection's listing shows it. The built-in
providers declare theirs. A provider without the list, such as an MCP server
whose tools are read when it is authorized, offers what its authorization
recorded.

Considered: authorizing again after an upgrade (the GitHub App's key is not
kept outside the connection's credential), and a migration that rewrites
recorded lists (it would need each provider's list in SQL, and gateway
configuration changes without a migration).

## Consequences

Upgrading Work or editing a gateway connection's actions reaches existing
connections at once, so a committed binding is the only list that decides
what an Environment may use: a binding or role that lists no capabilities
gains every action a release adds, GitHub writes included, so bindings that
must stay narrow name their actions. A provider whose connections may do
only what they were granted (OAuth scopes) declares no list. An enablement
or trigger keeps the capabilities it was consented with. What GitHub itself allows is still decided by
the App's permissions or the person's account. An allocation keeps the
capabilities it was admitted with.
