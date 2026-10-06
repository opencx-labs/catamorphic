# 0204 — Sandboxes on any Linux machine: the container backend

- **Status:** Accepted
- **Date:** 2026-10-06
- **Refines:** 0047, 0164, 0167, 0176, 0184

## Context

Microsandbox needs hardware virtualization. Most cloud VMs, Hetzner Cloud
included, offer none, and nothing checked for it: a worker started with
`WORK_SANDBOX=microsandbox` enrolled, advertised capacity, then failed at its
first sandbox (#156). The only alternative was local-process, which isolates
nothing, boots no image, and enforces neither egress nor limits, so a team
toolchain image or a machine shared by several people could not run there.

## Decision

**A container backend.** `@catamorphic/container` runs each sandbox as an
OCI container through the Docker Engine API (Docker, or Podman's compatible
socket). Its runtime is `runsc` (gVisor, a user-space kernel: isolation
`sandbox`) or `runc` (kernel namespaces: isolation `process`). It offers what
microsandbox offers: images, Dockerfile builds (the build context is the
Dockerfile alone, as in ADR 0176), CPU and memory limits, members' sign-ins,
volumes (ADR 0208), background processes, and nested containers: the image's
own Docker daemon runs inside the sandbox. gVisor virtualizes the
capabilities that daemon needs and has no NAT, so nested Docker runs without
iptables: published ports and container-to-container traffic work, and
nested containers reach the outside only through the sandbox's proxy (an
open sandbox that runs containers under gVisor gets a proxy that admits
anything, for them). Under runc the sandbox would have to be privileged,
which is one more reason runc stays process isolation, and the operator must
accept it (`WORK_CONTAINER_PRIVILEGED=1`). A privileged container can leave
its network namespace and reach the machine, so such a machine advertises no
`network.policy`, and a shared control plane treats it as plain processes.
The workspace is a Docker volume of the sandbox's own, removed with it:
gVisor's root filesystem (`--overlay2=root:self`, its default) starts over
from the image when a container restarts, so a restarted sandbox keeps its
workspace and volumes, and runs its setup again. Persistent volumes are
Docker volumes too, which the daemon removes whatever user wrote into them.
Every sandbox runs at most 4096 processes (`PidsLimit`,
`WORK_SANDBOX_PIDS_LIMIT`). The provider records each sandbox while creating
it, in its state directory, and a worker that starts removes those whose
maker died before handing them over, so none holds volumes forever; a
pooled machine's reset removes every sandbox of the provider before its
volumes.

**Egress without a firewall.** An open sandbox joins `work-sandboxes`, a
bridge network the provider creates with inter-container traffic off, so
open sandboxes of different people on one machine cannot reach each other;
they ask the machine's own name servers. A restricted one has no network
interface but loopback. Its only way out is a socket of its own, mounted
from the machine, on which the worker serves an HTTP proxy that admits the
allowlist (`CONNECT` for TLS, absolute URLs for plain HTTP) and resolves
names itself. The proxy reads a host strictly (names of letters, digits and
hyphens, or IP literals; anything else, a control character included, is a
400 before any lookup), checks every address a name resolves to, IPv4-mapped
IPv6 as IPv4, and connects to a checked address. The machine's own
addresses (loopback, unspecified, link-local with cloud metadata) are
refused even to an open proxy unless an IP entry names that exact address
and port, as a development gateway's `127.0.0.1:<port>` does. It reads a
request head within 30 seconds and holds at most 256 connections per
sandbox. A forwarder inside the sandbox listens on `127.0.0.1:3128` (and,
for nested containers, on their bridge's gateway, never on an address other
sandboxes reach), and `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and
`NODE_USE_ENV_PROXY` point there. Anything that ignores the proxy has no
route out, so the policy fails closed. gVisor must be allowed to open host
sockets (`runsc --host-uds=open`) and nested Docker needs raw sockets
(`--net-raw`); a `runsc` runtime without them does not advertise
`network.policy` or `containers`.

**Choosing a backend.** `WORK_SANDBOX=auto` is the default on servers and
workers: microsandbox where it can run (macOS, or Linux with a usable
`/dev/kvm`), else the container backend with gVisor where the Docker daemon
has a `runsc` runtime, else with runc where a daemon answers, else
local-process. The machine logs its choice and the reason, and operators see
it with the machine. A backend named explicitly that cannot run refuses to
start and says what is missing. A worker that runs in a container finds the
host path of its data directory by inspecting its own container, so the
daemon mounts what the worker wrote.

**Control-plane agents.** A Postgres control plane still refuses agents as
its own plain subprocesses. A container keeps agent code out of the
server's environment and files, so the container backend qualifies there as
microsandbox does, except with privileged runc containers.

Considered: iptables rules per sandbox (domain allowlists need DNS snooping
and break on CDNs), and sibling containers through a filtered host socket for
nested Docker (`localhost` would not reach the services a test started).

## Consequences

Any Linux machine with Docker runs isolated sandboxes for several people,
with images, egress policy and limits enforced, and `auto` picks the best a
machine offers. gVisor adds system call overhead to I/O-heavy builds. Nested
containers under gVisor cannot reach the internet except through the proxy.
Tools that ignore proxy variables, and protocols other than HTTP (Git over
SSH), have no network in restricted Environments, as with microsandbox's
domain rules. Under gVisor, what an agent installs outside its workspace and
volumes is gone after a restart. The container backend cannot cap a
sandbox's disk (`storageMb`); microsandbox sizes its VM's root disk.
