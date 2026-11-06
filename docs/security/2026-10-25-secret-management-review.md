# Secret management review, 2026-10-25

## Assessment

The review found and fixed security issues in tenant isolation, credential
storage, connection revocation, OAuth completion, transcript masking and request
logging. The company-brain security model should keep company credentials behind
connection gateways, with current member authority checked on every use. Giving
a secret to an agent's process gives that process the ability to read and copy it.

Two confirmed lifecycle gaps remain open. Removing a database reference does not
guarantee eventual removal of its encrypted vault record. The proposed repair is
[ADR 0282](../decisions/0282-vault-deletions-survive-reference-removal.md), deliberately
deferred from this change at the user's request. Separately,
failed upstream revocation does not preserve a durable retry with the required
credential material. ADR 0282 does not solve provider revocation. This review does
not claim that all company-brain security requirements are complete.

This is a source review with synthetic regression tests, not a penetration test
or an investigation of deployed credentials. No production credentials or
credentialed external integrations were used.
The review began at `febd8994` and the repairs were developed on
`security/secrets-audit`.
PR preparation integrated `main` at `66acbffa`; the remaining design concerns
below are documented only and are excluded from the implementation scope.

## Scope

Reviewed project-secret declarations and shared/member values; tenant and
project checks; vault encryption and key selection; desktop credential stores
and renderer-facing metadata; OAuth authorization completion and cancellation;
allocation-bound connection, MCP, HTTP, model and Git use; secret delivery and
transcript masking; API logging; rotation and deletion lifecycles; and host
configuration for the stock server and desktop. Provider-specific upstream
security, deployment key custody and arbitrary user code remain host/operator
responsibilities.

## Findings and fixes

Severity describes plausible impact before the fixes, rather than evidence of
exploitation. Related failures are grouped by security boundary.

| Severity | Finding | Repair and evidence |
| --- | --- | --- |
| High | Some secret reads did not first establish that the project belonged to the supplied tenant. The old plaintext migration path could return and reseal another tenant's value. | Every value/run/sandbox/masking entry now checks tenant/project authority. Delivery history checks the session tenant and stays within the requested project. Cross-tenant regression tests cover refusal. |
| High | Project secrets and desktop agent credentials could fall back to plaintext. Older formats and corrupt stores could be silently accepted or reset. | Project secrets require a vault; migration 069 removes the value column and requires a reference. Desktop stores require secure OS encryption, validate supported fields and preserve unsupported/corrupt files by refusing them. Tests cover missing encryption and unchanged state after failure. |
| High | Connection snapshots and gateway authorization caches could outlive member permissions or binding changes, including while awaiting approval. | Removed the HTTP/model authorization caches. The broker resolves live member authority and committed bindings, narrows the allocation snapshot, checks current Git repository policy, and rechecks authority and containment after approvals. Gateways reauthorize after body admission and before forwarding. Regression tests cover revocation and permission narrowing without an upstream call. |
| High | OAuth callback completion reconstructed a root identity from pending state. Authority could be revoked, or authorization canceled, during a provider exchange. | Callbacks require the host's live identity resolver. Authority is checked before and after exchange. Attempt completion and credential publication commit in one database transaction for every scope; cancellation either wins before publication or sees a completed attempt. Tests cover removed/downgraded administrators, cancellation during vault preparation, and later sign-in/refresh during provider release. The stock server includes current administrative permissions in the resolver. |
| High | A sandbox-channel grant could reach the connection MCP endpoint. | The endpoint now requires an MCP-channel grant. A route regression test rejects a sandbox grant. |
| High | Desktop connection metadata could include an OAuth confidential client secret or unexpected persisted fields. API-key hints could expose all or nearly all of a short or medium-length key. | Encrypt confidential OAuth client configuration; explicitly allowlist public metadata; reject unknown stored fields; show a fixed mask with no key fragments at any length. Tests cover renderer metadata, key lengths and failed encrypted updates. |
| High | Linux's `basic_text` safeStorage backend could be treated as secure encryption. | Credential stores reject `basic_text` and unknown backends. The existing exception is limited to explicitly designated disposable Linux E2E profiles. Electron documents the hardcoded password used by `basic_text` in its [safeStorage reference](https://www.electronjs.org/docs/latest/api/safe-storage). Injected-backend tests cover acceptance and refusal. |
| High | Streaming transcript ingestion could persist an unmasked initial/replacement snapshot before later deltas completed a key. Ambiguous prefixes could disclose a longer secret's suffix. Object keys and numeric values could bypass masking. | Initial and replacement snapshots use the same streaming holdback as deltas. Holdback preserves overlapping secret prefixes; structured masking covers keys and numbers. Regression tests cover all these cases, plus a synthetic check of 86 chunk boundaries. |
| High | Raw URLs and provider exception fields could place credentials in request logs, errors or connection audit records. | Request logs use route templates; unexpected errors and unmatched routes use safe handlers; unknown provider failures and logged error types are fixed strings. Desktop and stock factory use safe logger serializers. Tests capture actual Fastify and gateway logs containing synthetic URL/header/body/exception secrets and verify their absence. Explicit integer HTTP error statuses 400 through 599 are preserved with generic response bodies. Custom embedders must apply the documented logger/handler configuration. |
| Medium | Explicit server vault keys silently retained an adjacent local-key fallback; envelopes without a key id were accepted. | Configured keys now define the entire keyring. Envelopes require a key id and exact GCM nonce/tag lengths; explicit previous keys still support rotation. Tests cover tampering, cross-tenant/ref substitution and explicit rotation. |
| Medium | In-memory vault keys formed by delimiter concatenation could alias tenant/ref pairs. | Tuple encoding removes ambiguity. Desktop vault references also require the UUID format generated by that vault. Regression tests cover alias attempts. |
| Medium | Secret environment variables could override additional runtime security controls. | Added reserved Bun, Git, TLS and key-log variables to the existing reserved-variable policy. |
| Medium, deferred | Failed deletion after reference removal and project/session cascades can leave recoverable encrypted records. | Proposed durable Postgres cleanup in ADR 0282. The user explicitly deferred implementation from this PR. |
| Medium, open | A failed provider revocation is recorded as an error, but the local credential reference is already cleared and the vault record is still deleted. | Local gateway use is denied, but upstream invalidation has no durable retry retaining the necessary material. Confirmed in `ConnectionsService.revoke` and its existing upstream-failure test. Needs a separate durable revocation lifecycle; the deletion-only proposal does not cover it. |

## Remaining design concerns for a company brain

The largest confidentiality boundary is raw-secret delivery into a workspace.
ADR 0206 explicitly permits later teammates' commands in that same workspace to
read copies retained in processes and files after the designated secrets file
is removed. Transcript masking does not prevent extraction or transformed
output. Per-member delivery therefore must not be represented as ongoing
per-member confidentiality across workspace sharing. Prefer gateway operations
for company credentials; a workspace that must receive private material needs
an execution boundary that remains exclusive to its authorized owner for its
lifetime, or destruction and clean replacement before another principal uses it.
That would change the accepted sharing behavior and needs an explicit decision.

Credential secrecy and action safety are separate. The gateway can protect a
key while an agent uses its allowed actions to retrieve sensitive data or make
an unwanted change. Resource/action restrictions and host-injected guards exist,
but there is no mandatory business policy: no applicable guard means an otherwise
authorized action is allowed. A company host must define the resources, writes,
exports and approvals it intends to permit. This is a policy responsibility
rather than a reason to replace the gateway architecture.

The control plane and its operator remain trusted. Standalone filesystem vaults
without configured keys keep `vault.key` beside their records, so copying that
whole directory includes what is needed to decrypt it. Shared object-store
deployments require explicit keys; the host can also supply keys through its
existing hook. Encryption does not protect against a compromised process that
can request plaintext. The keyring supports opening old records, but there is no
built-in inventory/re-encryption procedure proving an old key can be retired.

Finally, keeping every delivered value for future masking is deliberate secret
retention, including old rotated values. A durable removal queue repairs orphan
cleanup, not the retention policy for still-referenced session history or
backups. That policy must be explicit before claiming that deleting or rotating
a project secret erases every stored copy.

## Breaking changes and removed compatibility

[ADR 0281](../decisions/0281-secret-storage-has-one-encrypted-format.md) records the
encrypted-only format, consistent with the requested alpha cleanup:

- No plaintext project-secret storage, no lazy plaintext sealing, and no
  no-vault delivery-history fallback.
- No desktop plaintext credential import or old delegation-route conversion.
  Unsupported stores fail without overwriting the original file.
- No encrypted envelope without a key id, and no implicit local key when a
  configured server keyring exists.
- No installed-plugin OAuth-client fallback for missing saved configuration.
- No HTTP/model authorization cache that preserves revoked authority.
- No gateway admission object carrying decrypted access data between hooks.
  Early body admission returns a boolean; forwarding resolves current access.

Migration 069 refuses to run while plaintext rows exist. It preserves those rows
on failure; it does not erase them to make the migration succeed. Operators must
resolve such alpha data deliberately before upgrading. Historical SQL migrations
remain unchanged. Keep wrapping keys and their backups separate from database
backups. Retain explicitly configured previous keys until all records using them
have been replaced; automatic inventory/re-encryption is not implemented.

## Company-brain operating boundaries

1. Keep company API/database credentials in gateway connections. Give agents
   capabilities with restricted resources and actions. Environment injection is
   appropriate only when the process must receive the actual value.
2. Supply a current identity resolver on every shared host. It must reflect
   account suspension, membership, project roles and host-owned administration
   permissions. The stock server explicitly recognizes its existing internal
   setup/operator principal; arbitrary user ids do not receive that authority.
   A completed upstream operation cannot be undone by later local
   revocation; the checks apply to admission of subsequent operations.
3. Never use credential values as workflow inputs or outputs. Replay payloads,
   workflow results and ordinary application data are durable and do not become
   a secret store because a string resembles a token.
4. Masking reduces accidental transcript disclosure. It cannot prevent code
   that holds a credential from encoding it, writing it to a file or sending it
   elsewhere. Existing short-value exclusions also apply. Rotated delivered
   values remain sealed in session history so later turns can still be masked.
5. Deleting a stored value does not revoke the upstream credential or erase
   copies already delivered to running processes. Provider revocation, process
   termination, file cleanup and backup retention are separate controls.
6. Configure proxy, telemetry and host logging to avoid credential-bearing URLs,
   headers, bodies and exception strings. The library cannot sanitize an
   independent log pipeline that records the request before it reaches a route.
7. Existing audit/content fingerprints are unkeyed SHA-256 digests. They expose
   equality and permit offline guessing of low-entropy values to anyone who can
   read that metadata. Use random credentials and restrict audit/database access;
   fingerprints are not an additional encryption boundary.
8. Ordinary configuration is not automatically classified as secret material.
   For desktop MCP connections, put credentials in encrypted headers, environment
   values or OAuth fields. If an endpoint requires a token in its URL, reference
   an encrypted environment value with `${TOKEN}`; do not embed the literal
   credential in the saved URL, command or arguments.

## Independent PR review

Three independent read-only agents reviewed encrypted storage and migration,
connection authorization/OAuth, and transcript masking/logging. The storage
review found no actionable issue. The other reviews found an HTTP status
regression and authorization races involving cancellation, refresh, containment
changes during approval, and authority changes during vault preparation. The
repairs preserve explicit HTTP error statuses, repeat current containment checks,
and publish credentials atomically with attempt completion after rechecking live
authority. Follow-up reviews reported no further actionable findings in those
repairs. Supplemental review also removed credential-bearing exception names
from gateway warnings.

The final focused run passed 71 tests across four files, and core typechecking
passed. Follow-up review is clear. None of the deferred design gaps has been
implemented.

## Verification

The complete `bun run check` passed all 11 phases against `main` at `66acbffa`:
lint, root and workspace typechecks, builds, database migration and codegen,
the generated-type comparison, orchestration tests, workspace tests, PWA E2E
and the complete isolated desktop E2E suite.

| Relevant suite | Result |
| --- | --- |
| Root orchestration | 184 passed |
| Core | 1,066 passed |
| API | 215 passed |
| Work server | 277 passed |
| Desktop unit tests | 1,939 passed, 6 skipped |
| PWA end-to-end | 13 passed |
| Desktop end-to-end | 663 passed, 6 configured skips across 89 files |
| Focused final review regressions | 71 passed across 4 files |
| Focused server operator/gateway regressions | 15 passed across 5 files |
| Focused agent-store regressions | 14 passed |

The deterministic workspace phase completed all 69 tasks. The earlier native
fixture blockers were resolved by changes already merged to `main`; this audit
did not duplicate those fixture or product changes. API spec/client generation
completed, and `git diff --check` is clean. Hosted CI is verified separately on
the pull request's commit.

Regression tests reproduced cross-tenant plaintext access, plaintext fallback,
streaming leaks and the authorization races before their repairs. Validation
uses local fixtures, fake providers and disposable databases. It does not cover
real-provider integration behavior or replace deployment-specific key custody
and policy review.
