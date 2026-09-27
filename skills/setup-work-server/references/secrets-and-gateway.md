# Secrets, connections, and the gateway

Use this when a Work server should let agents or workflows act on company
systems: APIs, a production database, internal MCP tools (ADRs 0162, 0163).
The rule: workloads get permission to act, never the credential. The Work
server holds credentials in its vault and makes each call itself, after the
configured guards review it.

Simple servers need none of this. Add it when a project needs a system that
holds company data.

## Choose the mechanism

| Need | Use |
| --- | --- |
| An HTTP API with a key (billing, CRM, internal service) | An `http` gateway connection |
| Reading a production database | A `postgres` gateway connection to a read-only replica role |
| Tools behind an MCP server | An `mcp` gateway connection |
| A value a workflow's own code must read (a webhook signing secret, a non-sensitive token) | A project secret (`defineSecrets`), sealed in the vault |

Prefer a gateway connection whenever the value is a credential: the call is
reviewed and audited, and the key never enters a sandbox.

## Keys the server itself needs

- `WORK_SECRET` signs sign-in state. Required for Postgres deployments.
- `WORK_VAULT_KEY` encrypts the credential vault: 32 random bytes as base64
  (`openssl rand -base64 32`). Required for Postgres deployments; standalone
  installs generate an owner-only key file instead. Keep it separate from
  `WORK_SECRET` and back it up separately from the database.
- Rotation: set the new key as `WORK_VAULT_KEY` and the old one in
  `WORK_VAULT_PREVIOUS_KEYS` (comma-separated). New records use the new key;
  keep the old key until every credential has been re-entered or rotated.
  Roll the change to every instance: an instance must hold at least one key
  the deployment already uses, or it refuses to start.
- A custom server can fetch keys from a key management service at boot with
  the `vaultKeys` hook of `@catamorphic/work-server`.

Store all of these with the deployment's secret mechanism. Never commit them,
print them, or pass them to agents.

## The gateway configuration

`WORK_GATEWAY_CONFIG` names a JSON file read at startup:

```json
{
  "connections": [
    { "type": "postgres", "kind": "prod-replica", "displayName": "Production (replica)",
      "maxRows": 500, "maxCost": 100000, "statementTimeoutMs": 10000, "poolSize": 4 },
    { "type": "http", "kind": "billing", "displayName": "Billing API",
      "baseUrl": "https://api.billing.example/v1", "paths": ["/invoices", "/customers"] },
    { "kind": "company", "displayName": "Company tools",
      "url": "https://tools.example.com/mcp" },
    { "kind": "slack", "displayName": "Slack", "url": "https://mcp.slack.com/mcp",
      "oauth": { "client": { "id": "1234.5678", "secretEnv": "SLACK_CLIENT_SECRET" } } }
  ],
  "guards": [
    { "type": "model", "name": "query-review", "kinds": ["prod-replica"],
      "policy": "Read only the rows the stated purpose needs. Never read credentials, tokens, or payment data.",
      "model": { "provider": "anthropic", "id": "claude-haiku-4-5" } },
    { "type": "approval", "name": "billing-writes", "kinds": ["billing"],
      "actions": ["post", "put", "patch", "delete"] }
  ]
}
```

Connection kinds become connection providers: what a connection can reach
and how. The file is host policy, not project logic; it holds no credential. GitHub
is built in as the `github` kind ([Connect GitHub](connect-github.md)); do
not declare it here.

- `http`: `maxResponseBytes` (at most 16 MiB, default 1 MiB) is the largest
  part of a body one call returns, and `timeoutMs` (at most 120000, default
  30000) bounds each request. A larger GET body is read in parts: the result
  carries `range.nextOffset` and `range.totalBytes`, and the agent asks for
  the next part with `range: { "offset": … }`, writing parts to files in its
  workspace rather than into the conversation. A 5 MiB pull request diff is
  five calls, not a truncated one.
- `postgres`: each service connection keeps up to `poolSize` sessions (at most
  16, default 4), closed after `poolIdleTimeoutMs` idle and at once when the
  credential rotates or is revoked. Every call still gets its own read-only
  transaction, timeouts, cost ceiling, and cursor budget.
- `mcp`: `oauth.client` names a client registered in advance with the MCP
  server's authorization server, for servers that do not register clients
  dynamically (Slack's). Register the redirect URI
  `<WORK_PUBLIC_URL>/api/connection-authorizations/callback`; put a
  confidential client's secret in the variable `secretEnv` names.

## Service connections and administrators

A service connection is a named credential the organization owns, used by
agents and automations when no person is present. Organization
administrators create, authorize, rotate, and revoke them; members never see
the credential and project roles cannot grant this (ADR 0172).

Make the first administrators with the operator API on the loopback
listener, then administrators promote others in the app:

- `POST /_work/operator/users` with `"administrator": true` for a local user,
  or `POST /_work/operator/administrators` with `{ "email": … }` for someone
  who has signed in once. `GET` lists them; `DELETE …/administrators/:userId`
  removes one.
- In the app, an administrator sees **Service connections** in a connected
  project's Server section; `GET/POST /api/work/administrators` and
  `DELETE /api/work/administrators/:userId` do the same over the API. The
  last administrator cannot remove themselves there.

Connect a service connection (the operator routes mirror the API):

1. `GET /_work/operator/connection-providers` lists the kinds from the file.
2. `POST /_work/operator/service-connections` with
   `{ "name": "prod-replica", "providerKind": "prod-replica" }` creates it,
   pending. Names are lowercase; add `"principalKind": "project_service"` and
   `"projectId"` for a connection only one project may bind.
3. `POST /_work/operator/service-connections/:id/authorize` returns the
   provider's challenge. A form (an API key, a read-only connection string)
   completes with `POST …/authorize/complete` and
   `{ "authorizationId", "fields": { … } }`; the value goes straight to the
   vault. A URL challenge completes when the administrator signs in at that
   URL; the provider returns to the server's callback.
4. Authorizing a ready connection again rotates it. `DELETE
   /_work/operator/service-connections/:id` revokes it and frees the name.

Never paste a credential into a chat, a repository, or a command line an
agent can read. Enter it through the form in the app, or have the operator
enter it on the server machine.

## Bindings are committed

Each Environment in `.work/project.json` declares the aliases its work may
use, and which service connection backs each by name:

```json
{
  "environments": {
    "review": {
      "workloads": ["agent"],
      "pool": { "pool": "review" },
      "connections": {
        "github": { "provider": "github", "principal": "service", "service": "github",
                    "capabilities": ["get", "post"] },
        "prod": { "provider": "prod-replica", "principal": "service", "service": "prod-replica",
                  "capabilities": ["query", "explain", "schema"] },
        "mail": { "provider": "mail", "principal": "member" }
      }
    }
  }
}
```

`principal` is `member` (each person's own account), `service` (the named
service connection), or `either`. `capabilities` narrows the alias; leave it
out to keep what the connection allows. Agents and workflows name the alias
(`"connections": ["prod"]` in an agent definition); roles grant it. Changing a
binding is a reviewed change to the project, published like any other.
Invalid entries show as an invalid Environment. A project service connection
of the same name wins over the organization's.

Guards review every action on the connection kinds they name, from agents and
workflows alike. A deny refuses; an escalation asks the person in the agent's
chat to approve; a workflow's escalation is refused because nobody is there to
answer. A model guard's key comes from the provider's usual variable
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) or the variable
named in `apiKeyEnv`. Use `"provider": "openai-compatible"` with `baseUrl` for
a self-hosted classifier; its `apiKeyEnv` is optional. Every decision is in the connection audit.

## A production database, safely

1. Create a read replica or use an existing one.
2. Create a role that can only read, ideally only through views that leave out
   secrets and personal data:

   ```sql
   CREATE ROLE work_reader LOGIN PASSWORD '…';
   GRANT USAGE ON SCHEMA reporting TO work_reader;
   GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO work_reader;
   ```

   The gateway refuses superusers, table owners, and roles with any write
   privilege when the credential is entered.
3. Declare a `postgres` connection and a model or approval guard for it.
4. An administrator creates the named service connection and enters the
   read-only connection string once; the project commits a binding for the
   Environment that needs it.
5. Verify from an unattended project chat or automation in that Environment:
   an allowed query returns rows; `DELETE`, two stacked statements, and an
   unfiltered scan above the cost ceiling are refused with readable reasons;
   the audit lists each decision, and no worker file holds the connection
   string.

Result rows enter the model's context, so keep personal data out before a
query can reach it:

- Point the connection at a replica and a schema of views that leave out
  personal and secret columns (`reporting.customers` without email or phone).
- Grant columns, not tables, where a view is not practical:
  `GRANT SELECT (id, plan, created_at) ON customers TO work_reader;`.
- Add a model guard whose policy names what must never be read (for example
  "refuse queries selecting email, phone, address, or payment columns") as a
  redaction check before the query runs. It reviews the SQL and purpose, not
  the rows, so it is a second layer; the views and grants are the boundary.

## GitHub

GitHub Actions secrets cannot be read back through GitHub's API, so the Work
server cannot import them. Keep CI secrets in GitHub and enter the credentials
Work needs through connections or project secrets. GitHub itself is the
`github` service connection, a GitHub App installed on the relevant
repositories, never a personal token ([Connect GitHub](connect-github.md)).
