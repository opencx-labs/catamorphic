# 0162 — The connection gateway: guards, sealed secrets, separate vault keys

- **Status:** Accepted
- **Date:** 2026-09-25
- **Refines:** 0033, 0054, 0065, 0099

## Context

A company brain needs agents and automations to act on sensitive systems
(production databases, billing APIs, GitHub) without those credentials
reaching the machines that run agent code, and with every action reviewable.
ADR 0065 already brokers connection calls in the control plane: agents get
short-lived grants, never upstream secrets. Three gaps remained: nothing could
review an individual action (only allowlist its name), project secrets sat in
Postgres as plain text and were injected as environment variables, and shared
deployments derived the vault key from the same secret that signs sign-ins.

## Decision

**The broker is the gateway.** Hosts inject `ConnectionActionGuard`s. Every
brokered action, from an agent or a workflow, is reviewed by the guards that
apply to its provider kind, in order: any deny refuses, any escalation needs a
person, and a failing guard refuses. A guard that does not answer in time
escalates. An agent's escalation becomes the ordinary durable approval card
in its session (ADR 0054). A workflow cannot wait on a person mid-step, so its
escalations are refused. Each decision is audited with the actor (the session
owner, not the grant), the caller kind, the guards' verdicts, and the approval
outcome. Refusals reach the agent as readable tool errors so it can narrow its
request. The credential never appears in what guards see.

**API keys are brokered, not injected.** A built-in HTTP API connection keeps
an API key in the vault and adds it to requests for one HTTPS origin and
optional path prefixes, never following redirects and refusing
caller-supplied identity or routing headers. Its actions are the HTTP methods,
so roles can grant `get` alone.

**Project secrets are sealed.** With a credential vault configured, a project
secret row holds only a vault reference. Rows written before sealing are
sealed the first time they are read. Runs and webhook verification unseal
through one service method; management APIs still expose presence only.

**Vault keys are their own secret.** The encrypted vault takes a keyring: the
first key seals, later keys open older records during a rotation. Shared
deployments require `WORK_VAULT_KEY` (or a boot hook that fetches keys from a
key management service); nothing derives it from the sign-in secret. Every
instance must agree on the current key id.

Considered: an egress proxy that substitutes secrets into arbitrary outbound
traffic. Rejected for now: it needs TLS interception inside sandboxes and hides
which system an action touched. The typed gateway keeps actions reviewable.

## Consequences

Classifiers, SQL policies, and rate limits plug in as guards without touching
providers. A database dump plus the deployment secret no longer reveals
connection credentials or project secrets. Environment-injected secrets still
reach the run that declares them; ADR 0164 restricts where such runs execute.
