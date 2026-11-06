# 0283 — Linux modules use namespaces and seccomp

- **Status:** Accepted (extends 0277)
- **Date:** 2026-10-25

## Context

Project source modules need the same approved file and host boundary on Linux
as on macOS, without a VM for every sidebar module. Apple still deprecates both
`sandbox-exec` and `sandbox_init`; App Sandbox is an entitlement and signing
model, with no supported drop-in API for our dynamic process profiles.
Claude Code and Codex still use Seatbelt on macOS. Both use Bubblewrap and
seccomp for their current Linux sandbox. Landlock alone cannot restrict TCP
to one proxy IP: its network rules name ports, not destination hosts.

## Decision

Keep Seatbelt on macOS, including explicit process/task restrictions and an
allowlist of public runtime sysctls. Raw kernel process-argument/environment
reads must fail, not only reads through command-line tools. Bun and the RPC
worker are file grants; resolving the worker may list its parent but never
read siblings. No runtime installation location grants a whole home folder.
File data, executable mappings and execution are denied globally, then allowed
only for public OS runtime paths, the project, own scratch and explicit grants.
A denylist of common home/temp roots misses other private locations. Listing
the filesystem root is a literal directory grant, never recursive access.
On Linux, Bubblewrap gives each module a mount, user,
PID, IPC, UTS and network namespace. Start from an empty read-only root, add
system runtime files, the project and approved reads, and bind only scratch
and approved writes as writable. Mount distribution runtime folders explicitly;
never mount all of `/usr`, which also exposes private `/usr/local` configuration.
Mount public CA bundles rather than whole SSL directories with private keys.
Scratch is keyed by profile, project identity
and module, so profiles with different approvals never share private files.
Open canonical grants with `O_PATH | O_NOFOLLOW`, verify their resolved paths,
and mount their inherited descriptors with Bubblewrap's `--[ro-]bind-fd`.
Replacing a pathname between approval and setup cannot substitute another
file. Bubblewrap consumes these handles before the workload starts.
Mount fresh `/proc` and a private `/dev`.
There is no host home, display socket, session bus or inherited credential.

Reuse the `apply-seccomp` executable from pinned
`@anthropic-ai/sandbox-runtime` 0.0.81, without its global manager or policy.
It creates a second PID/mount namespace, hides the unfiltered relay from the
workload, sets no-new-privileges and blocks Unix/VM sockets and namespace/mount
escape calls. The filter is mandatory. Only the RPC pipe crosses as fd 3.
Work builds its short allow-only mount list itself, preserving its signed
canonical grants rather than adopting shell-oriented policy defaults.

With approved hosts, one trusted system `socat` listener inside the outer
network namespace reaches a per-launch Unix endpoint on Work's existing HTTP
proxy. The proxy checks hosts, protected listener ports and pinned DNS answers
identically on both platforms. There is no direct network, DNS or SOCKS route.
No host relay process is needed. With no hosts, no relay or proxy is started.

Missing tools, unsupported architectures or namespace/filter failures stop the
module. Never reuse host `/proc`, host networking or silently run unconfined.
Only disposable E2E profiles retain the existing explicit bypass.

## Consequences

Linux needs Bubblewrap, Bash and (for networked modules) socat, and a kernel
and host policy permitting unprivileged user and nested PID/mount namespaces.
Require Bubblewrap 0.12+ for descriptor mounts and the destination symlink
resolution fix (GHSA-pxhw-h44j-8pfx); do not rely on older distro versions
whose backport was reverted. The workload receives no mount descriptors.
The packaged helper supports x64 and arm64 and is unpacked outside ASAR.
On Ubuntu, use a scoped AppArmor allowance for Bubblewrap and the helper's
nested namespaces (some distribution profiles deliberately refuse these);
do not disable host security as a product workaround.

Bind mounts need existing file/directory targets. A missing approved target
fails clearly instead of granting its parent; directory write grants allow
creation and atomic replacement beneath them. A grant for one existing file
supports in-place writes, but replacing that mountpoint is not supported.
File watchers observe the bound directory; replacing its inode requires a
worker restart. These Linux limits do not widen access on either platform.
Neither backend sets CPU or memory quotas. Measure startup, process-tree RSS,
CPU, idle and IO separately; this is isolation, not a resource budget.
