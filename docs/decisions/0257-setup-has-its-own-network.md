# 0257: Setup has its own network

- **Status:** Accepted (amends 0208)
- **Date:** 2026-10-18
- **Refines:** 0175, 0176, 0204, 0207, 0212

## Context

A pull request review runs the pull request's code in a sandbox whose only
way out is the gateway. Installing its dependencies needs package registries
(npm, GitHub Packages, Docker Hub). Setup cannot run outside the sandbox: it
runs the pull request's install scripts. Setup needs more network while it
runs, and the agent's first turn must find the sandbox narrow again.

## Decision

**The manifest.** An Environment's `setup` is an object, replacing the
string and `setupTimeoutMinutes`: `{ "command": "pnpm install
--frozen-lockfile", "timeoutMinutes": 30, "network": { "allow":
["registry.npmjs.org"] } }`. Entries follow `network.allow`'s rules.
`setup.network` needs a `gateway` or `allowlist` network: open egress has
nothing to widen.

**When it runs.** As before, and when the workspace's base moved (ADR 0178):
`setup.done` records the base commit, so a review chat reset to each push
sets up again. The Environment's part runs when its command or the base
changed, the member's when theirs changed or after the Environment's. Each
part is recorded as it succeeds.

**Admission fixes both policies.** An Allocation fixes `egress` and
`setupEgress`: the Environment's allowlist, the setup's hosts and the
gateway. Its sandbox switches only to one of the two, compared by value.
Placement requires `network.setup`: the machine switches a running
sandbox's egress, closing every connection open through it.

**Only a new sandbox widens**, one this preparation made, decided from the
control plane (the session had none), never from files in the sandbox.
Order: created narrow, widened, the Environment's part, narrowed in a
`finally` once its process exited or was killed, the session's sandbox
grants issued again with the old ones revoked at once, the member's part,
the turn. A sandbox an earlier preparation made is narrowed before anything
reaches it, in case that one stopped while it was wide. Following a setup
an earlier preparation started never widens. Where narrowing fails, the
sandbox is stopped, its grants revoked, and the attempt fails. A setup that
must run again in such a sandbox (command changed, base moved, an earlier
failure) gets a new one in the same Allocation first: changes since the
last turn are saved as at idle release, the sandbox is destroyed, and its
volumes stay. A restart is not enough: what an agent gathered (rows read
through the gateway) survives on disk, and the next setup's install scripts
could send it to a host the setup may reach.

**What setup can reach.** Volumes persist on the machine (ADR 0208) and
carry data between sandboxes: a review Environment keeps only caches there
and accepts that risk. Project secrets (ADR 0206), the session's grants and,
in a member's own chats, their files and sign-ins are in place while the
Environment's part runs, so the allowed hosts could receive them; those
hosts are reviewed with the command.

**Providers.** `setEgress` and `network.setup`. The container backend swaps
its proxy's compiled policy in memory: each switch is a generation, every
socket is destroyed while the proxy keeps listening, and a decision begun
under an older generation (awaiting DNS) is dropped. The container label
keeps the Environment's own policy, so a worker restart or a stop and start
falls back to narrow; nested containers use the same proxy. Microsandbox
fixes a VM's network policy at creation (snapshot and restore make a new
sandbox), so it does not offer `network.setup`. Local-process offers it, as
a no-op, only under `WORK_UNENFORCED_EGRESS=accept`. A chat's folder on a
person's computer (ADR 0215) skips an Environment's setup that names a
network, and says so.

**Remote executors.** The queue carries an `egress` operation, answered
within a minute. Capability gating keeps older executors safe: they never
offer `network.setup`, so placement never sends them a switch, and protocol
2 workers are still driven. Workers speak protocol 3 so one meeting an older
control plane is told to update it, rather than failing on a capability its
offer schema does not know.

Considered: setup outside the sandbox (it runs the pull request's scripts),
a restart before a second setup (files survive), and wider egress for the
whole chat (the agent could send what it reads).

## Consequences

Review sandboxes install from registries, and the agent reaches only the
gateway. Every push to a reviewed pull request makes a new sandbox, kept
cheap by warm volumes. Microsandbox machines cannot host these
Environments. A terminal a person opened before setup ran again goes with
its sandbox.
