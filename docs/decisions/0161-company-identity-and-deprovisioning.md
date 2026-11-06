# 0161 — Company identity: Google Workspace sign-in and deprovisioning

- **Status:** Accepted
- **Date:** 2026-09-25
- **Refines:** 0071, 0072

## Context

A company brain must admit only people in the company's identity directory and
must lose them when the directory does. The Work server trusted an email
domain at sign-in, created an account for anyone the provider vouched for, and
never looked upstream again: refresh tokens slid forward indefinitely and
nothing could disable an account. A personal Google account registered with a
company address passed the domain check.

## Decision

**Workspace sign-in.** The auth configuration gains a `google-workspace`
provider kind. It requests the configured hosted domain and accepts only ID
tokens whose `hd` claim names an allowed Workspace domain with a verified
email. The email domain alone never proves Workspace membership. Generic OIDC
providers keep `allowedDomains`.

**Directory.** A provider-neutral `DirectoryProvider` answers whether an
upstream account is active and whether it belongs to named groups. The Google
implementation calls the Admin SDK Directory API with a service account that
holds a read-only admin role (no domain-wide delegation), from a key file or
the metadata server. Suspended, archived, or deleted users, and users missing
from every required group, are inactive. Hosts can inject other directories.

**Account lifecycle.** Inactive accounts are disabled: every request is
rejected, all sessions and OAuth tokens are deleted, the member's runners and
live agent turns are stopped, and their unattended workflow enablements are
suspended. Disabled is a state, not a deletion; memberships and history stay
for audit and an account that becomes active again signs in normally. The
server checks the directory at sign-in and at most five minutes before any
refresh is honored, and sweeps every account with live tokens every five
minutes. Sign-in fails closed. For existing sessions, a directory outage is
tolerated for at most the configured grace window (default 30 minutes since
the last successful check), then refresh fails closed.

**Tokens.** Access tokens live 15 minutes. Refresh tokens rotate on every use
within one family; presenting a rotated token revokes the whole family. A
family expires after 14 idle days and after an absolute 30 days, which forces
a new upstream sign-in. All three are configurable downward.

**Directory groups become roles.** A project admission policy may map
directory groups to committed roles. The server reconciles these grants at
sign-in and on every sweep, adding and removing only the roles it manages;
roles granted by invitation or by a manager are untouched.

Considered: SCIM provisioning (Google Workspace offers it only for catalog
applications) and relying on Google revoking its own tokens (it does not
revoke tokens issued by the Work server). Push events through Google's
Cross-Account Protection can shorten the window later; the sweep remains the
guarantee.

## Consequences

A departure takes effect within about five minutes, bounded by the sweep
interval, without any action in Work. Operators create one service account and
assign it a read-only admin role. Local password sign-in should be disabled for
company deployments. The directory contract stays provider-neutral; nothing in
the framework becomes Google-specific.
