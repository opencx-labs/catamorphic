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
    { "type": "postgres", "kind": "prod-db", "displayName": "Production (replica)",
      "maxRows": 500, "maxCost": 100000, "statementTimeoutMs": 10000 },
    { "type": "http", "kind": "billing", "displayName": "Billing API",
      "baseUrl": "https://api.billing.example/v1", "paths": ["/invoices", "/customers"] },
    { "kind": "company", "displayName": "Company tools",
      "url": "https://tools.example.com/mcp" }
  ],
  "guards": [
    { "type": "model", "name": "query-review", "kinds": ["prod-db"],
      "policy": "Read only the rows the stated purpose needs. Never read credentials, tokens, or payment data.",
      "model": { "provider": "anthropic", "id": "claude-haiku-4-5" } },
    { "type": "approval", "name": "billing-writes", "kinds": ["billing"],
      "actions": ["post", "put", "patch", "delete"] }
  ]
}
```

Connection kinds become connection providers. Commit the project's aliases,
Environment connection bindings, and role capability grants through ordinary reviewed
project files; the file above is host policy, not project logic. The first
person to authorize a connection enters its credential through the
connection's form (an API key or a read-only connection string); it goes
straight to the vault.

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
4. Verify as a member: an allowed query returns rows; `DELETE`, two stacked
   statements, and an unfiltered scan above the cost ceiling are refused with
   readable reasons; the audit lists each decision.

Result rows enter the model's context. Keep sensitive columns out with views
and grants; the classifier is a second layer, not the boundary.

## GitHub

GitHub Actions secrets cannot be read back through GitHub's API, so the Work
server cannot import them. Keep CI secrets in GitHub and enter the credentials
Work needs through connections or project secrets. For code review work, prefer
a GitHub App installed on the relevant repositories over a personal token.
