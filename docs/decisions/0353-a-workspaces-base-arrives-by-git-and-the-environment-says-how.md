# 0353 — A workspace's base arrives by Git, and the Environment says how it is checked out

- **Status:** Proposed
- **Date:** 2026-11-25
- **Amends:** 0178, 0208, 0257, 0343, 0344

## Context

A sandbox was handed the commit its chat stands on as one pack: built whole in
the server's memory, encoded, and uploaded in one provider operation (ADRs
0257, 0344). On a remote machine that operation is one row of JSON, so the
pack is encoded twice and a repository of roughly 144 MiB or more could not
start a chat at all. A project that wanted a pull request reviewer on a large
monorepo found its first turn failing before any agent ran.

The size was only the visible half. Because Work pushed the files, nothing
about the checkout was the project's to say: every file always arrived,
nothing an image or an earlier base already held was reused, and a monorepo
could not take one corner of itself. Each of those is something Git already
does when the receiver fetches.

## Decision

**Work serves a workspace's base over Git.** `<gateway>/checkout/<id>` speaks
Git's smart HTTP for one commit of one session's copy. The session's copy
already holds its base wherever the base came from (a ref of the project's
remote, ADR 0178, or Work's own `main`), so a project with no repository is
served the same way, from Work's own origin. Each request is answered from a
repository made for it and thrown away: it borrows the copy's objects, ends
history at the commit, and advertises one branch there. `git upload-pack` runs
with protocol version 0, where the server checks that every want is reachable
from what it advertised, so the commit, its tree and its files can be fetched
and nothing else the copy holds, whatever object id is named. Filters are
allowed, and an object reachable from the branch may be asked for by id, which
is what a partial clone does. Nothing is pushed to a checkout.

**A checkout is a grant that ends.** Core issues it for one session and one
commit (`workspace_checkouts`: the token's hash, an expiry, a revocation),
gives the sandbox the token as an HTTP header in the command's environment
(`GIT_CONFIG_*`, scoped to the checkout's URL, written to no file), and revokes
it when the command ends, however it ended. It lives at most the command's
timeout plus a minute. A fetch without a live token is answered 403 with the
reason as text, which Git prints; a 401 would only ask for a username.

**The Environment says how it is checked out.** `checkout` in an Environment:

```json
{ "checkout": { "command": "git sparse-checkout set --cone apps/web .work && git fetch --depth=1 --filter=blob:none work \"$WORK_BASE\" && git checkout --detach FETCH_HEAD", "timeoutMinutes": 15 } }
```

Work makes the project folder a Git repository with a remote named `work`,
and runs the command there (`bash -e`) with `WORK_BASE` naming the commit.
When it ends, `HEAD` must be that commit: the id is the content's own hash, so
a checkout that names it holds it, and one that ends anywhere else fails the
turn with what the command printed. How much arrived (every file, a sparse
cone, no blobs until they are read) is the command's to say. Without one, Work
fetches the commit whole with no history:
`git fetch --depth=1 work "$WORK_BASE" && git checkout --force --detach FETCH_HEAD`.
The remote goes with the token, unless the command left objects out: a partial
clone reads those through its remote, so it stays without a credential, and
what is asked of it later is refused, saying why.

**When it runs.** Whenever a sandbox's checkout does not hold the base: a new
workspace, one rebuilt after idle release, and a base that moved (Git then
sends what the checkout lacks). Before setup, and before anything of a
session's arrives. A setup on its own network (ADR 0257) has its base fetched
first, while the sandbox still reaches only the gateway; the token has ended
before the network widens.

**What the session added still arrives as a pack, without the base.** The
agent's commits and the files of its saved tree that differ from the base are
uploaded, so they need no credential (ADR 0344). The pack no longer holds the
base, travels in parts of at most 4 MiB so that no operation grows with it,
and is not sent at all when the session added nothing.

**Where sandboxes cannot fetch.** A host that serves no gateway to its
sandboxes keeps uploading the base, now in parts, and so does one whose
sandbox could not reach the gateway it names: when Work's own fetch fails, the
base is uploaded and the server's log says why. A command the Environment
names is never replaced that way: its failure fails the turn, and it is
refused with the reason where no gateway is served. Cache fills (ADR 0334)
also keep the upload: a fill's sandbox is made on the setup's network and
never reaches the gateway.

Considered: fetching from the project's remote with a code-host grant (a
credential for the code host in a sandbox that otherwise holds none, nothing
for a project without a repository, and a base on Work's own `main` is not
there to fetch); only uploading in parts (lifts the ceiling and leaves every
checkout whole and from scratch; kept as the fallback); a checkout workflow
in place of a command (what a project changes here is one Git invocation
inside the sandbox, and `setup.workflow`, ADR 0324, already runs a procedure
after it); a token that outlives the command so a partial clone can read
lazily (a standing grant to read a session's copy from a sandbox that runs
untrusted code); protocol version 2 (it does not check that wants are
reachable).

## Consequences

- A repository's size no longer bounds whether a chat starts; the transfer
  streams, and a base that moved costs its difference.
- A monorepo takes a cone of itself, or leaves blobs out, by naming a command.
  Such a checkout cannot read what it left out once the command has ended:
  the command fetches what the work needs.
- A sandbox briefly holds a token that reads its own base. It can read nothing
  the sandbox is not about to be given, and it has ended before setup, before
  a setup's network, and before the agent.
- Git checkout needs a sandbox that reaches the gateway and a Git that reads
  configuration from its environment (2.31 or newer); hosts that mount the
  gateway routes serve checkouts with nothing more to configure.
- Follow-up: cache fills fetching by Git, which needs a fill sandbox that
  starts narrow and widens for its command.
