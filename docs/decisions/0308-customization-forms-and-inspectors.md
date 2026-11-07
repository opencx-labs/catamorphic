# 0308: Customization forms and inspectors

- **Status:** Accepted
- **Date:** 2026-11-07
- **Amends:** 0234, 0239, 0307

## Context

Hand testing two agent-built todo lists exposed duplicated opening choices,
no manual add flow, clipped reminder details, and unnecessary list recreation
when context changed. The person requested reusable forms, reminder presets
and custom times, multiple reminders, inspector actions and richer content.

## Decision

Work composes standard row commands once by semantic action and destination.
Explicit menu overrides still replace their placement, including an empty menu.
A source cannot fix host duplication by guessing which commands to omit.

The existing action input contract supports scalar controls, sibling conditions
and one level of repeatable groups. Values cross IPC as typed JSON. Select
options, labels, units, reminder presets and application validation belong to
the source; these controls introduce no todo or scheduling service. Date/time
inputs show the machine timezone and submit ISO instants; ambiguous local
instants are refused. Complex editing screens remain ordinary apps.

Inspectors preserve label casing, wrap facts and support semantic tones,
value displays, copy controls and source actions. Markdown supplies rich prose;
arbitrary interactive content reuses an ordinary sandboxed project app with its
existing consent and lifecycle; a source must declare the existing apps-list grant
to compose one. Inspector commands keep the source row target restrictions.
No generated HTML or code runs in shell React.

A list's identity comes from its source and data scope, never ordinary current
surface changes. Non-session-scoped lists retain their collection, expanded
branches, DOM and focus while refreshing context. Explicitly session-scoped
lists keep separate chat data. Stable row IDs are the source's responsibility.

## Consequences

Guidance explains the installed contract and includes a checked add/reminder
example. Evaluation covers manual creation, presets and custom times, repeated
values, readable hover actions, reordering, context changes and restart, plus
ordinary durable notification execution. Native form and pointer behavior are
verified in an isolated desktop, separately from source-handler checks.
