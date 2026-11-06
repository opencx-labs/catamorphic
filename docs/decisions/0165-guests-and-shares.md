# 0165 — Guests and shares for people outside the company

- **Status:** Accepted
- **Date:** 2026-09-25
- **Refines:** 0055, 0135, 0161

## Context

A company brain produces material for customers: pilot progress apps, status
documents, folders of deliverables. Customers must sign in, see only what was
shared with them, and never touch the brain itself. Publications (ADR 0055)
cover documents for members or anyone; making a customer a project member
exposes the whole API surface and every future role mistake. We considered
nested "subprojects" per customer.

## Decision

**Shares, not subprojects.** A share addresses one document, one folder, or
one app of a project to named emails or email domains, with an optional
expiry. A member holding `publications:write` creates it; the link is
`/s/<id>` on the server's public origin. Each customer's material lives in the
brain (for example `customers/acme/` and an `acme-pilot` app) and is shared
from there. A separate project remains the answer when a customer needs its
own agents, workflows, or secrets; projects are already cheap, so no new
nesting concept is needed.

**Guests are a separate kind of account.** Sign-in providers carry an audience:
`members` (the company, ADR 0161) or `guests` (customers' own identity
providers, such as the company's product accounts via OIDC). Share links offer
both; ordinary sign-in offers members only. Accounts are never linked
implicitly, so a guest sign-in cannot attach to a member. A guest never
becomes a member, never receives an OAuth token, and is refused by the API's
identity resolver. Members can also open shares addressed to them, and project
managers with `publications:read` can open any share of their project.

**Viewing is confined.** The share page uses a browser session and derives an
identity that reads exactly the shared document or folder, or opens exactly
the shared app, with no permissions, connections, or agents. App workflows run
only in the Environment the share names, which the creator must be allowed to
use. Shared apps run in the usual credential-free sandboxed frame; the page
relays their calls, and the server re-authorizes each. Viewer writes require
this origin and a share header. Downloads are served with a sandbox CSP so
shared files never execute on the server's origin. Opens, downloads, and app
calls are recorded per viewer.

## Consequences

Customer material gets a sign-in without customer accounts inside the brain.
Revoking a share, or its expiry, cuts access on the next request. Shared apps
cannot use member connections or agent collections. Email one-time codes for
guests without an identity provider need an email transport and are follow-up
work.
