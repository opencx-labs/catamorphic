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
  minutes over every member who has signed in and is not disabled. Suspended,
  archived, and deleted users, and users outside every required group, are
  disabled: all their tokens and sessions are deleted, running agent turns
  stop, and their unattended workflows suspend at their next dispatch.
- Access tokens last 15 minutes. Refresh tokens rotate on every use, reuse of
  a rotated token revokes the whole session, sessions expire after 14 idle
  days and 30 days total. These can be shortened, never lengthened.
- Directory groups can grant committed project roles. Leaving the group
  removes exactly the roles the mapping granted.
- Someone joining, leaving, or changing groups starts the project workflows
  bound to it, such as issuing a new engineer's keys and revoking them when
  they leave (ADR 0210; see Onboarding and offboarding automations below).

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
   A custom server that reads the key from a secret manager passes it inline
   in `config.auth` instead (`"credentials": { "key": <the key JSON> }`).
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

## Onboarding and offboarding automations

The account lifecycle above starts project workflows (ADR 0210), so a project
can issue a new engineer's keys when they join and revoke them when they leave.
Three trigger kinds carry it:

| Kind | Fires when |
| --- | --- |
| `directory.member-joined` | An account becomes active: its first sign-in (the first code exchange from the desktop, the PWA, or an MCP client), or a sign-in the directory approves after the account was disabled. |
| `directory.member-left` | An account is disabled: the directory reports it suspended, archived, deleted, or outside every required group. |
| `directory.groups-changed` | The directory groups of an active member change. |

Each run's input is the event: `input.id`, `input.occurredAt`, and
`input.payload` with `member` (`id`, the member's user id; `email`; `name` or
null; `domain`, the email's domain), `groups` (their groups, lowercased; for a
departure, the groups they last held) and, for `groups-changed`, `added` and
`removed`. Groups are the ones the server asks the directory about: groups
that map roles, worker access and machine rules, and groups a directory
trigger names. A group the server starts or stops asking about is not a
change in anyone's groups.

- `trigger("directory.member-joined", { groups: ["engineering@example.com"] })`
  starts runs only for members of any of those groups. On `groups-changed`,
  `groups` selects changes that add or remove one of them.
- `where` narrows by any other field, such as one email domain:
  `where: { payload: { member: { domain: "example.com" } } }`.
- A workflow that binds these kinds must declare `memberships:read`. The
  project check and the server refuse the binding otherwise, and only someone
  who holds every permission the workflow declares can turn it on.
- Directory events name people. Every project with such an automation
  receives the email, name and tracked groups of everyone who joins, leaves
  or changes groups on the server, including people who are not members of
  that project, and its workflows can send them anywhere they can reach.
  Only someone whose role in that project grants `memberships:read` can turn
  one on, and only someone who can publish there can add the workflow; only
  the operator creates projects. Grant those roles, in any project whose
  automations may listen to the directory, only to people the company
  trusts with its directory, and review changes that add these triggers.
- A transition is recorded with its event; delivering the event to the
  projects happens right after and retries until it succeeds. A departure
  disables the account and signs it out whether or not that delivery
  works, and one account's events always arrive in the order they happened.
- Events reach only projects with the automation turned on, and each
  automation sees each change once. Changes from before an automation was
  turned on are not replayed: issue keys to existing members by hand or with a
  one-off run. A server without a directory still fires `member-joined` at each
  account's first sign-in; nothing there fires the other two.

Workflows give a member a value of their own with
`host["catamorphic.secrets"]` (ADRs 0206, 0210): `set({ name, value, member })` and
`delete({ name, member })` name the member by email or id, need the workflow
to declare `secrets:write`, and keep the value write-only. Declare the secret
in `.work/project.json` and list it in the `secrets` of each Environment
whose sandboxes need it; each member's chats then receive their own value:

```json
{
  "secrets": {
    "CLICKHOUSE_API_KEY": { "description": "Your own ClickHouse key, issued when you join" }
  },
  "environments": {
    "default": { "workloads": ["agent", "workflow"], "secrets": ["CLICKHOUSE_API_KEY"] }
  }
}
```

This project automation issues a ClickHouse Cloud API key to everyone in the
engineering group when they join and revokes it when they leave. It reads an
admin key from the project secrets `CLICKHOUSE_ADMIN_KEY` (as
`keyId:keySecret`) and `CLICKHOUSE_ORGANIZATION_ID`; adapt the two steps to
another service's API. A run may retry, so issuing first revokes any key a
failed attempt left, and keys are found by their name, never by a stored
value.

```typescript
// .work/workflows/src/clickhouse-keys.ts
import {
  type BoundaryContext,
  defineSecrets,
  defineWorkflow,
  type TriggerPayload,
  trigger,
} from "@catamorphic/workflow";

export const secrets = defineSecrets({
  CLICKHOUSE_ORGANIZATION_ID: { description: "The ClickHouse Cloud organization that issues keys" },
  CLICKHOUSE_ADMIN_KEY: { description: "A ClickHouse Cloud key that manages keys, as keyId:keySecret" },
});

/** Where the organization's keys live, and the admin key's credentials. */
function keysApi() {
  return {
    url: `https://api.clickhouse.cloud/v1/organizations/${secrets.CLICKHOUSE_ORGANIZATION_ID}/keys`,
    headers: {
      authorization: `Basic ${Buffer.from(secrets.CLICKHOUSE_ADMIN_KEY).toString("base64")}`,
      "content-type": "application/json",
    },
  };
}

/**
 * @displayname Revoke ClickHouse keys
 * @icon key-round
 * @param email - @displayname Email | @description Whose keys to revoke
 */
async function revokeClickHouseKeys({ email }: { email: string }) {
  "use step";
  const { url, headers } = keysApi();
  const listed = await fetch(url, { headers });
  if (!listed.ok) throw new Error(`Listing ClickHouse keys failed: ${listed.status}`);
  const { result } = (await listed.json()) as { result: { id: string; name: string }[] };
  const keys = result.filter((key) => key.name === `work ${email}`);
  for (const key of keys) {
    const revoked = await fetch(`${url}/${key.id}`, { method: "DELETE", headers });
    if (!revoked.ok) throw new Error(`Revoking ClickHouse key ${key.id} failed: ${revoked.status}`);
  }
  return { revoked: keys.length };
}

/**
 * @displayname Issue a ClickHouse key
 * @icon key-round
 * @param email - @displayname Email | @description Who the key is for
 */
async function issueClickHouseKey({ email }: { email: string }) {
  "use step";
  const { url, headers } = keysApi();
  const created = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `work ${email}`, roles: ["developer"], state: "enabled" }),
  });
  if (!created.ok) throw new Error(`Issuing a ClickHouse key failed: ${created.status}`);
  const { result } = (await created.json()) as { result: { keyId: string; keySecret: string } };
  return `${result.keyId}:${result.keySecret}`;
}

/** @displayname Issue engineers their ClickHouse key */
export const issueEngineerKeys = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["memberships:read", "secrets:write"],
  triggers: [trigger("directory.member-joined", { groups: ["engineering@example.com"] })],
  steps: [
    /** @displayname Issue and store the key */
    defineBoundary({
      run: async ({ input, host }: BoundaryContext<TriggerPayload<"directory.member-joined">>) => {
        const { email } = input.payload.member;
        await revokeClickHouseKeys({ email });
        const value = await issueClickHouseKey({ email });
        return host["catamorphic.secrets"].set({ name: "CLICKHOUSE_API_KEY", value, member: email });
      },
    }),
  ],
}));

/** @displayname Revoke leavers' ClickHouse keys */
export const revokeLeaverKeys = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["memberships:read", "secrets:write"],
  triggers: [trigger("directory.member-left", { groups: ["engineering@example.com"] })],
  steps: [
    /** @displayname Revoke their keys */
    defineBoundary({
      run: async ({ input }: BoundaryContext<TriggerPayload<"directory.member-left">>) => {
        const { email } = input.payload.member;
        await revokeClickHouseKeys({ email });
        return { email };
      },
    }),
    /** @displayname Delete their stored key */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ email: string }>) =>
        host["catamorphic.secrets"].delete({ name: "CLICKHOUSE_API_KEY", member: input.email }),
    }),
  ],
}));
```

The key is issued and stored in one boundary, so it is never a boundary's
output, which the run keeps as the next boundary's input. The host call is
that boundary's returned transition: return it, never await it. To
issue keys to people added to the group later, bind
`directory.groups-changed` with the same `groups` and act when
`input.payload.added` holds the group.

Turn both on as project automations: someone holding `memberships:read` and
`secrets:write` (an administrator role, usually) enables each workflow for
the project, after storing `CLICKHOUSE_ADMIN_KEY` and
`CLICKHOUSE_ORGANIZATION_ID`. To verify, sign in once with a new test account
in the group, then check that the run succeeded and that the secret lists the
account as holding a value; suspending the account revokes it within one
sweep. Issuing and revoking real keys are external actions: do them only
with the operator's approval.
