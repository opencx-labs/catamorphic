# 0176 — Environments choose images, containers, egress, and what agents may change

- **Status:** Accepted
- **Date:** 2026-09-27
- **Refines:** 0054, 0056, 0100, 0158, 0162, 0167, 0175

## Context

Server-side agents all ran in one global image, could not start containers,
and had open network egress. An agent's `mode` only ranked delegation, a
committed definition's `toolPolicies` were ignored on the Work server, and an
unattended chat's approval quietly denied after five minutes because no one
was watching. Verifying a change (install, `docker compose up`, run the
tests) and running reviews with no person present both need more than that.

## Decision

**Environments choose their image.** `environments.<name>.image` is an OCI
reference (`node:22`) or a project Dockerfile path
(`.work/images/review.Dockerfile`), so images are reviewed like code. At
admission the control plane reads the Dockerfile from the same program as
the manifest (64 KiB cap) and fixes its content and digest in the
Allocation. Machines build it once and cache it by digest. Microsandbox
builds with the host's Docker or Podman (`WORK_IMAGE_BUILDER`) and loads
the result into its image cache. The build context is the Dockerfile alone.
Build steps use the builder's own network, not the Environment's egress
policy, which governs the running sandbox: an image is shared by every
Environment naming that Dockerfile, and a builder cannot enforce a domain
allowlist. The Dockerfile is reviewed with the program for that reason.

**Containers are a declared requirement.** `requirements.containers: true`
needs a machine that gives the sandbox its own container runtime. Docker
runs inside a microsandbox VM on a disk owned by that sandbox (the VM's
overlay root cannot hold overlay storage), so containers, networks and
volumes die with the VM; the image supplies `dockerd` (`docker:dind`, or a
Dockerfile from it). A trusted local-process machine (`WORK_DOCKER_SOCKET`)
gives each sandbox a filtering Docker endpoint on its own socket
(`DOCKER_HOST`). It serves an allowlist of API routes and, for each body it
forwards, an allowlist of fields and values; anything else is refused. It
alone sets the owner label, on everything created, and it lists and touches
only labelled objects. It refuses privileged containers, added capabilities
and devices, host namespaces, volume drivers other than `local`, and bind
mounts outside the sandbox directory. Builds go through the classic
builder's `/build`, whose options it can check, not BuildKit's gRPC session.
It removes every labelled container, network and volume when the sandbox
is destroyed. It reduces what a trusted daemon exposes; it is not a boundary
against hostile code.

**Egress is an Environment policy.** `network: { egress: "open" | "gateway"
| "allowlist", allow?: [domain | *.suffix | IPv4] }`, default open.
`gateway` reaches only the control plane's public host and port (and DNS);
`allowlist` adds the listed hosts. Microsandbox enforces it with a
deny-by-default network policy, which also covers nested containers.
Local-process cannot enforce it; an operator may accept that explicitly
(`WORK_UNENFORCED_EGRESS=accept`), otherwise placement refuses.

**Machines advertise, placement matches.** Providers declare `images`,
`images.build`, `containers` and `network.policy`; worker offers and
control-plane descriptors carry them, and an Environment's image, containers
and restricted egress become capability requirements (ADR 0167 matching).

**Modes govern what leaves the sandbox**, enforced by core, harness-independent.
An agent may run anything inside its own sandbox.
- `read-only`: nothing is synced back, shipped to the store, or checkpointed;
  only read capabilities run; connection actions must read (a provider's
  `readOnly(action)`, else the action's `readOnlyHint`).
- `edit`: may propose and use what the bindings grant; capabilities marked
  `full-access` (deploy, publish, revoke a publication) are refused.
- `full-access`: everything bindings and roles allow.
Refusals say what the agent may do instead. A definition's `mode` and
`toolPolicies` are applied by core on every host, layered with role
policies (ADR 0054).

**Approvals reach people.** A project chat, or one an automation named
`approvers: { members, roles }` for when it delivered, routes each escalation
(tool `ask`, gateway guard) to those people through notifications and
attention; they may answer without otherwise holding the chat. It waits
`environments.<name>.approvals.waitMinutes` (default 30), then denies with a
reason. With no approver it is refused at once. Workflow steps still refuse.

## Consequences

Migration 031 stores a chat's approvers. Resource budgets cover the VM, so
nested containers count against its CPU and memory; the Docker disk has its
own size, and local-process containers are unbudgeted. Git pushes through
the gateway (ADR 0175) must check the session's mode when that lands; the
project MCP endpoint serves members, not sessions, so it applies roles, not
modes. Member devices do not advertise these capabilities yet, and warm
images do not yet steer placement.
