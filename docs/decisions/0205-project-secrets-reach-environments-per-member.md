# 0205 — Project secrets reach Environments, with a value per member

- **Status:** Accepted (refined by [0211](0211-http-apis-reach-code-in-sandboxes-through-the-gateway.md): the gateway's variables load beside the secrets)
- **Date:** 2026-10-06
- **Amends:** [0162](0162-connection-gateway-guards-and-sealed-secrets.md), [0175](0175-grants-reach-sandboxes.md), [0184](0184-personal-credentials-reach-a-members-own-sessions.md)

## Context

Developers working in remote Environments need the same variables they have
on their laptops: a shared Sentry DSN, a test Stripe key, and keys that are
each person's own, such as a ClickHouse key issued to every engineer when they
join. A project secret had one value and reached only workflow runs on the
control plane. Personal files reached a member's own chats, but only the
member could send them, from their desktop, and nothing set environment
variables in a sandbox.

## Decision

**One secret, a shared value and a value per member.** A project secret may
hold a shared value and one value for each member. Secrets are declared by
`defineSecrets` in workflow code, by a plugin, or in `.work/project.json`
under `secrets` (`{ "NAME": { "description": "..." } }`), which is where
secrets only Environments use belong. Values are write-only: APIs report
presence, who set a value and when, never the value.

**Who sets them.** A shared value needs `secrets:write`. A member's value may
be set by that member, by anyone holding `secrets:write` (someone onboarding
a new colleague), or by a workflow that declared `secrets:write`
(`catamorphic.secrets`, ADR 0209).

**Environments say what reaches their sandboxes.** An Environment lists
names in `secrets`; the list is reviewed like the rest of `project.json`.
Each listed name becomes an environment variable:

- in a member's own chat, the member's value or else the shared one, when
  the owner wrote the turn's input (ADR 0199) and the placement isolates the
  owner (a VM or gVisor sandbox, a machine only they use, their own device,
  or a machine whose operator accepted it, as for personal credentials);
- in a project chat, the shared value, when the placement isolates the
  project's work the same way;
- in workflow runs, the shared value, as before.

Secrets declared only in `project.json` are for Environments; runs keep
receiving the secrets their code or plugins declare. Names that would change
how the sandbox's shells, Git, Node, TLS, the harnesses' model access or the
egress proxy behave (`PATH`, `HOME`, `BASH_ENV`, `NODE_OPTIONS`,
`GIT_CONFIG_*`, `GIT_SSH_COMMAND`, `SSL_CERT_FILE`, `LD_PRELOAD`, `DYLD_*`,
`ANTHROPIC_BASE_URL`, `CODEX_HOME`, the proxy variables and the like) are
reported to the agent, never set.

This amends ADR 0175: values a project lists for an Environment may reach
that Environment's sandboxes. Connection credentials still never do; prefer a
gateway connection whenever a value grants access to a company system.

**Delivery.** Before each sandbox turn (and when a person opens the
workspace, ADR 0208) the resolved variables are written to
`.work-session/env/secrets.sh` (mode 0600, in a folder made the sandbox
user's alone before anything is uploaded into it, outside the repository).
The chat records that it has held secrets before they are written, and the
file is removed whenever a turn may not have them (another person wrote the
input, the placement no longer isolates the owner, the Environment no longer
lists them) and when the workspace is given back. The agent runner reads it
again for every attempt and passes the variables to the harness, values
untouched, with `BASH_ENV` pointing at the file (Bash skips `BASH_ENV` when
its standard input is a socket, so the variables themselves are what shells
inherit); the built-in agent's commands, terminals and workspace setup source
it. A listed secret with no value for the owner is named to the agent with
who can set it. Each delivery is audited by name and fingerprint. A turn that
received them in a member's chat takes only that member's input, as for
personal files, and a refused answer says so.

**Masking.** Once a chat has held secrets, every later turn of it, whoever
wrote the input, and every turn of its forks and subsessions masks every
value it could repeat: its transcript, its workspace's processes and files
keep them. That is the owners' own and the shared values, declared defaults,
and every value ever delivered to the chat, kept as a sealed record in the
credential vault, so a value rotated since stays masked. Values become
`[secret NAME]` wherever a turn's output is recorded or workspace output is
handed to the agent (the setup log's tail), in the forms output carries them:
as is, JSON-escaped, URL-encoded, base64, with either line ending and line by
line; streamed text that could be the start of one is held back. A process
that takes a running turn over masks the same values. A value shorter than
six characters cannot be masked: the agent is told not to print it, and the
audit names it. Operations that carry values to a worker are sealed to that
worker (ADR 0206).

**Personal files** stay the member's own (ADR 0184): files listed in
`.work/personal/environment.json`, behind `"personalCredentials": true`.

## Consequences

A new joiner's key can be issued by an automation and reaches only their own
chats. A value in a sandbox can be read by code running there, including a
compromised dependency; restrict egress where that matters. Projects that
list no secrets see no change.

Values the owner's own processes, terminals or files hold stay in the
workspace when the secrets file leaves it: a teammate's turn in that chat runs
in the same workspace without the file, and its commands can read what those
processes and files still hold; only what is recorded is masked. Masking
covers values delivered to the chat and values that exist now: a value
rotated before it ever reached the chat is not known to it, and a host
without a credential vault keeps no record of delivered values, so there a
rotated value is no longer masked. Masking is a guard on what is recorded,
not a boundary: an agent asked to transform a value (reverse it, split it)
can still print it.
