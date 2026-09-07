# 0098: Project-authorized local and remote agent execution

- **Status:** Accepted
- **Date:** 2026-09-07
- **Refines:** 0055, 0062, 0064, 0067, 0073, 0077, 0095
- **Managed server provisioning refined by:** 0099

## Context

A member connected to a company project should choose where an agent runs,
including their own device when permitted. Connecting a project currently mixes
local working copies, remote authority, and execution placement. Adding unrelated
server identities would make that experience harder to understand.

## Decision

Use the existing Environment and Allocation models. A project declares logical
Environments; the host supplies their runtime bindings and policy ceilings.
Roles grant access to those Environments, and agent policy may narrow the set.
The desktop presents the permitted choices as **Run on**, including **This machine**
when local execution is allowed and supported by the connected device.

A connected project retains one authority for membership, shared configuration,
connections, consent, and canonical session history. Running on the member's
device is execution placement, not a new project authority. Local execution must
retain the authenticated member's project permissions; the desktop's root
identity must not substitute for that member. Provider credentials stay in their
owning vault and project capabilities remain caller-bound.

The selected Allocation must govern the actual agent process, workspace, tools,
and recovery. A permitted target must also be available and compatible with the
agent. Do not silently fall back to another server or to local execution.
Moving existing work is explicit and preserves fenced execution ownership and
acknowledged history under ADR 0077; changing a selector cannot move an active
process in place.

Independent Catamorphic authorities are not part of this server picker. Hosts
expose approved execution targets beneath the connected project's authority.
This keeps one permission model and avoids cross-authority identity federation.

Incognito remains desktop-local. Connected projects cannot create incognito
chats: even their local sandbox execution has server-owned history. Restored
incognito tabs must never mount a remote chat or transmit their transcript.

The desktop's file browser and text editor operate on its local working copy
through desktop IPC. Document synchronization retains remote member checks.
Those filesystem tools are distinct from remote program APIs, agent execution,
and workflow consent; a remote authorization failure never falls back to root.

## Consequences

Members can run the same permitted agent locally or remotely without changing
project identity. Local execution depends on that device being available;
remote execution can continue after the member closes the desktop. The alpha
implementation should replace conflicting routing and global-provider paths,
rather than preserve compatibility layers. Physical runner transport and
provisioning must implement these existing authority and placement contracts.
