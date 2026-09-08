# Owner-bound unattended delegation

## Status

Design accepted in ADR 0068 on 2026-08-24. Implementation remains pending.

## Goal

Support Claude-style personal automations without allowing project-owned
workflows to borrow an arbitrary member's authorization.

## Required design

- Add an explicit `owner_bound` trigger ownership mode beside
  `project_service`.
- Bind the trigger to one member identity and exact member connections at
  enablement.
- Require an explicit durable-consent action from that member.
- Suspend the trigger when the owner is removed, loses the Environment or
  connection role grant, revokes the connection, or must reauthenticate.
- Make ownership and revocation visible in trigger status and audit events.
- Never fall back to another member's connection.
- Let agents invoked as workflow steps inherit the workflow owner,
  Environment, Allocation, and narrowed broker grants.
- Re-evaluate personal delegation at each broker call and preserve durable
  workflow recovery at the failed action boundary.

## References

- Claude Cowork scheduled tasks run remotely with the creator's configured
  connectors.
- Claude Enterprise-managed authorization centrally provisions connector
  access but still derives identity and lifecycle from each member's IdP
  identity.
