# Company identity: Google Workspace sign-in and deprovisioning

Use this when a Work server should admit only people in a company's Google
Workspace and lose them when the Workspace does (ADR 0161). Personal or small
servers can keep local sign-in or a generic OIDC provider; do not push this on
them.

What the server does once configured:

- Sign-in accepts only Google accounts whose ID token `hd` claim names an
  allowed Workspace domain. A consumer Google account using a company email
  address is refused.
- The Admin SDK Directory API is checked at sign-in, at every token refresh
  when the last answer is over five minutes old, and by a sweep every five
  minutes over every account with a live session. Suspended, archived, and
  deleted users, and users outside every required group, are disabled: all
  their tokens and sessions are deleted, running agent turns stop, and their
  unattended workflows suspend at their next dispatch.
- Access tokens last 15 minutes. Refresh tokens rotate on every use, reuse of
  a rotated token revokes the whole session, sessions expire after 14 idle
  days and 30 days total. These can be shortened, never lengthened.
- Directory groups can grant committed project roles. Leaving the group
  removes exactly the roles the mapping granted.

## 1. OAuth client

In the company's Google Cloud project:

1. Configure the OAuth consent screen with user type **Internal**. Google then
   refuses accounts outside the organization before the Work server sees them.
2. Create an OAuth client ID of type **Web application** with the authorized
   redirect URI `<WORK_PUBLIC_URL>/api/auth/oauth2/callback/google` (use the
   provider `id` in place of `google` if you change it). `WORK_PUBLIC_URL` must
   be the HTTPS origin people reach.

## 2. Directory access

1. Enable the **Admin SDK API** in the same Cloud project.
2. Create a service account. Prefer running the server as that account on
   Google Cloud (`"credentials": { "metadataServer": true }`). Otherwise create
   a JSON key, store it with the deployment's secret mechanism, and mount it
   read-only (`"credentials": { "keyFile": "/run/secrets/directory.json" }`).
3. A super admin opens the Admin console, creates a custom admin role with the
   Admin API privileges **Users: Read** and **Groups: Read**, and assigns it to
   the service account's email. Domain-wide delegation is not needed; do not
   grant broader roles.

## 3. Configuration

Write the sign-in configuration file (`WORK_AUTH_CONFIG`, default
`<WORK_DATA_DIR>/auth-config.json`) owner-readable only. It holds the OAuth
client secret; never commit it.

```json
{
  "local": { "enabled": false },
  "providers": [
    {
      "kind": "google-workspace",
      "clientId": "…apps.googleusercontent.com",
      "clientSecret": "…",
      "domains": ["example.com"],
      "directory": {
        "credentials": { "metadataServer": true },
        "requiredGroups": ["work-brain@example.com"]
      }
    }
  ]
}
```

`requiredGroups` is optional; without it every active Workspace account may
sign in (and still receives no project access without a membership). Optional
top-level `sessions` (`accessTokenMinutes`, `idleDays`, `maxDays`) and
`directory` (`checkMinutes`, `graceMinutes`) tighten the defaults. Restart the
server after changing this file. In a Postgres deployment every instance must
use the identical file.

## 4. Projects and the first manager

Local passwords are off, so bootstrap managers through the directory. Provision
the project with a mapping from an administrators group to the managing role:

```json
"admission": {
  "mode": "invitation_only",
  "defaultRole": "member",
  "directoryRoles": [
    { "group": "work-brain-admins@example.com", "roles": ["admin"] },
    { "group": "engineering@example.com", "roles": ["engineer"] }
  ]
}
```

Each mapped role must be one of the roles provisioned with the project.
Managers can change the mapping later through
`PUT /api/projects/:projectId/admission/policy` (`memberships:write`, plus
`roles:write` for roles that carry permissions). Without a directory mapping,
ask the first manager to sign in once, then grant their role through the
loopback operator operation `POST /_work/operator/memberships` with
`{ "email", "projectId", "roles" }`. It requires a verified email.

## 5. Verify

With a real test account in the Workspace, not a fixture:

1. Sign in through the desktop, PWA, or an MCP client; confirm `GET /api/me`.
2. Sign in with a personal Google account; it must be refused.
3. Suspend the test account in the Admin console. Within one sweep interval
   `GET /api/me` answers 401 and refresh fails. Restore it and sign in again.
4. Add and remove the account from a mapped group; confirm the role appears
   and disappears while other roles stay.

Contacting Google and suspending accounts are external actions: do them only
with the operator's explicit approval.

## Failure behavior

An unreachable directory refuses new sign-ins. Existing sessions continue for
at most the grace window (default 30 minutes since the last successful
answer), then refresh fails until the directory answers. A departure takes
effect within about one sweep interval; access tokens already issued are
refused on the next request because every request checks the account.

Other identity providers: a generic OIDC provider with `allowedDomains` checks
only the email domain at sign-in and has no deprovisioning. A custom server can
inject another directory through the `directories` hook of
`@catamorphic/work-server`.
