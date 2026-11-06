# 0257: Setup has its own network

- **Status:** Accepted (amends 0208)
- **Date:** 2026-10-18
- **Refines:** 0175, 0176, 0178, 0204, 0206, 0207, 0212

## Context

A pull request review runs the pull request's code in a sandbox whose only
way out is the gateway. Installing its dependencies needs package registries,
and setup cannot run outside the sandbox: it runs the pull request's install
scripts. A first design widened the agent's own sandbox for setup; a review
found that those scripts could then read a grant, rows an agent saved in
earlier turns, or a volume, and publish them to an allowed registry.

## Decision

**The manifest.** `setup` is an object: `{ "command": "pnpm install
--frozen-lockfile", "timeoutMinutes": 30, "network": { "allow":
["registry.npmjs.org"] }, "secrets": ["NPM_TOKEN"] }`. `setup.network` needs
a `gateway` or `allowlist` network. Its Environment declares no volumes: a
volume would carry what agents wrote into the next setup's wider network, so
caches belong in the image. `setup.secrets` names some of the Environment's
secrets; the setup's hosts could receive them.

**The widened setup sees the base checkout and the image, nothing else.** It
runs only in a workspace standing on a commit of the project's remote (ADR
0178), in a sandbox this preparation made, decided on the control plane.
The sandbox is made empty and seeded with the base commit alone, as a pack
from the session's copy (no grant is needed, so none can leak), with
everything else removed. Its session directory holds no grant, secret or
gateway variable. It is widened to the setup's hosts alone, neither the
gateway nor the Environment's own list. The Environment's setup runs with
the secrets it names as its environment and no secrets file. The sandbox is
narrowed; then the session's saved work is seeded, fresh grants issued,
secrets and the member's files written, the member's own setup run, and the
turn starts. Elsewhere the Environment's setup does not run and the agent is
told why: a folder on a person's computer, a workspace not at a ref (a fork,
or a chat on a draft), a sandbox holding its owner's sign-in from creation,
an Allocation admitted before the Environment named a setup network.

**When it runs.** As before, and when the base moved: `setup.done` records
the base commit, so a review chat reset to each push sets up again. The
Environment's part runs when its command or the base changed, the member's
when theirs changed or after the Environment's ran.

**A used sandbox is replaced, never widened.** Every sandbox an earlier
preparation made is narrowed first when its Allocation fixed a setup network.
When the setup must run again (command changed, base moved, an earlier
failure), the sandbox is marked, the work changed since the last turn saved
as at idle release (a contained agent's is lost, and it is told), destroyed,
forgotten, and a new one made in the same Allocation. A preparation that
stops midway leaves the mark, or a managed Allocation no longer owning the
sandbox; the next one finishes the replacement.

**Providers.** `widenEgress({ sandboxId, egress, id, until })` and
`narrowEgress({ sandboxId, id })`, capability `network.setup`. Every switch
closes every connection. The machine narrows by itself at `until` (the
setup's timeout and a minute, at most 245 minutes), so a dead control plane
cannot leave a sandbox wide, and refuses a widening whose `id` a narrowing
already ended, so one the control plane gave up waiting for cannot land
later. Allocation wrappers widen only to the fixed setup egress, compared by
value. Narrowing, and stopping a sandbox that cannot be narrowed, skip the
ownership checks: returning to a sandbox's own policy is always safe, and a
runner narrows sandboxes of an ended connection too. A failed narrowing
stops the sandbox, revokes the session's sandbox grants, and fails the
attempt. The container backend swaps its proxy's policy in memory: each
switch a generation, every socket destroyed, a decision begun under an older
generation dropped; the label keeps the Environment's own policy for a
restart. Microsandbox fixes a VM's network at creation and does not offer
`network.setup`. Local-process offers it, as a no-op, only under
`WORK_UNENFORCED_EGRESS=accept`. The queue carries `egress.widen` and
`egress.narrow`; workers speak protocol 3, the oldest the control plane
drives.

**What remains.** Code a setup leaves running stays in the sandbox once it
is narrow, and can use the grants and secrets written after, through the
gateway only: the authority the agent has anyway while it runs the pull
request's code.

Considered: setup outside the sandbox (it runs the pull request's scripts),
a restart before a second setup (files survive), widening the agent's
sandbox after its grants and work were in place (the first design), and
seeding through the gateway with a grant revoked after (a pack needs none).

## Consequences

Review sandboxes install from registries while holding nothing worth
sending, and the agent reaches only the gateway. Every push makes a new
sandbox and, with no volumes, installs from what the image caches.
Microsandbox machines cannot host these Environments. A terminal a person
opened before setup ran again goes with its sandbox.
