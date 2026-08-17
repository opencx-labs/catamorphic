# 0055 — Company brain: program vs. store, roles as files, scoped agents, the change loop

- **Status:** Proposed
- **Date:** 2026-08-18
- **Builds on:** 0044 (checkpoints, remote sync), 0050 (project agents),
  0053 (identity scope), 0054 (tool permissions)
- **Absorbs (parked in TODO.md):** publications, caller identity in runs,
  the authorize seam, user-connected blob storage

## Context

The dogfood case is concrete now. A company runs its brain as one
Catamorphic project on GitHub. **Admins** edit anything: workflows, skills,
agents, apps, docs. **Everyone else** — sales, CSMs, customer engineers —
uses the brain through an agent: questions answered from company docs,
selected tools and (for engineers) the codebase; sales generate decks and
contracts; CSMs ask about the customers they own. Most of them have no
GitHub access and reach the project through a remote agent served by the
company's own backend (the ADR 0054 remote-instance direction).

Three questions were open:

1. **Where do artifacts that not everyone may see live?** Customer
   contracts and per-customer knowledge cannot sit next to the handbook in
   a repo every admin clones — and even where that would be acceptable,
   putting them there gives the wrong change loop: a CSM's daily notes
   become commits on the program's history, authored by a bot credential,
   and workflows read only the deployed commit, so data would need deploys.
2. **Who owns access control, Catamorphic or the host?** ADR 0053 answered
   this for apps and workflows (scope is the *output* of host policy; core
   only enforces) but the vocabulary did not yet name agents or document
   subtrees, and nothing stamped who acted.
3. **How does a host — or the AI agent building it — get tight access
   control trivially?** Today the resolver returns a scope it must compute
   itself; the "authorize seam" was parked without a stock policy source.

## Decision

### 1. One project, two backings: the program in git, the data in the project store

A project has exactly one path namespace, backed two ways:

- **Git** holds the **program**: workflows, apps, skills, agents, roles,
  sidebar config, and knowledge everyone may read (`docs/`, handbook).
  Admins edit it; it deploys; everyone else reads the deployed commit.
  Unchanged from 0044/0050.
- **The project store** holds the **data produced by using the program**:
  per-customer knowledge and notes, contracts, generated decks, uploads —
  anything partitioned by audience, changed without review, binary, or
  read live rather than at a deploy. Rows are `(project, path, blob or
  text, version, written_by, written_at)` in the project's own database
  (0046's DB-per-project architecture), with a pluggable blob backend
  (local disk, the host's S3/R2) for large content. Store paths are
  gitignored subtrees of the project by convention (default root
  `store/`, declared in `.catamorphic/project.json`), so a path is
  unambiguous: under the store root it is store-backed, otherwise git.

Store content is versioned per write (a linear history per path, not
branches) and never needs a deploy. It is what publications publish (a
`document` ref to a store path or a git path at the deployed commit) and
what the parked blob-storage TODO was reaching for: large binaries in a
project without git-lfs. **This ADR retires the separate blob-storage
plan**: the store's blob backend is that feature.

Alternatives rejected: (a) *restricted directories inside the repo* — git
has no path ACL, and every repo reader is a reader of everything; (b) *one
repo per customer* — hundreds of repos, GitHub access as the access model
(the very thing non-admins lack), and no cross-customer queries; (c) *the
host stores everything, Catamorphic only calls host tools* — right for the
host's own structured records (they stay behind workflows/MCP), wrong for
the unstructured artifacts the brain itself produces, which would leave
every host building a store.

### 2. Access control: the host owns *who*, Catamorphic owns *what* and *enforcement* — as in 0053, with three extensions

`Identity.scope` stays the only enforcement vocabulary. It grows:

```ts
type ArtifactRef =
  | { kind: "app"; projectId; name; channel? }
  | { kind: "workflow"; projectId; name }
  | { kind: "document"; projectId; path }     // path may end in "/**": a subtree
  | { kind: "agent"; projectId; name };       // NEW: a project agent (0050) by slug
```

- **Agents are artifacts.** A scoped identity may open sessions on the
  agents its scope names, and on nothing else. `assertFullIdentity` stops
  guarding agent sessions; `narrowIdentity` to the agent ref guards them
  instead, exactly as app routes do. Inside such a session, **the caller's
  scope intersects the agent's tool policy** (0054's rule extended by one
  layer): the agent may read only store paths, call only workflows, and
  mount only apps that both its definition and the caller's scope allow.
  A CSM's agent literally cannot read another CSM's customers, whatever
  the model is told.
- **Document refs cover subtrees.** `customers/acme/**` grants a folder,
  in git (deployed commit, read-only for viewers) or in the store
  (read/write for viewers whose role says so; write permission is a
  property of the ref: `{ kind: "document", path, access: "read" |
  "write" }`, default read).
- **Every write and every run is stamped with the caller.** Store writes
  carry `written_by`; runs carry the triggering identity server-side and
  expose it as `context.caller` in `BoundaryContext` (never in `input`,
  which is author-typed). This is the audit trail, and what lets one
  shared workflow isolate per caller without trusting its input.

Builders (full identity) still see everything, including the whole store.
Hiding store content from *some admins* would be a role, not a builder
distinction, and is out of scope until a case demands it.

### 3. Roles are committed files; the resolver becomes one line

```
roles/<name>.json
{
  "version": 1,
  "name": "CSM",
  "agents": ["csm-assistant"],
  "workflows": ["crm.lookup", "docs.search"],
  "apps": ["customer-tracker"],
  "documents": [
    { "path": "docs/**" },
    { "path": "store/customers/{customer}/**", "access": "write" }
  ]
}
```

A visible directory next to `agents/`, for the same reason (0050): roles
are a work product admins author and review, and the AI building a host
app can write them. `{param}` placeholders are filled from per-user
**grants** the host supplies (`{ customer: ["acme", "globex"] }`); a role
with unfilled placeholders grants nothing for that entry. A `builder`
role is the one special name: it yields a full identity.

Core ships the expansion, not the membership:

```ts
identity: async (req) => {
  const u = await verifySession(req);           // the host's auth, as before
  return u && resolveRoles(core, { projectId, tenantId, externalUserId: u.id,
                                   roles: u.roles, grants: u.grants });
}
```

`resolveRoles` reads `roles/*.json` at the deployed commit and returns an
`Identity` with the expanded scope. Membership (`user → roles, grants`)
is the host's table — the stock self-hostable server is a host whose
table is its own. Dynamic policy (roles that depend on a CRM lookup) is
still just a host that computes `roles`/`grants` before calling
`resolveRoles`; the parked "authorize workflow" idea is not needed.

Roles never enter `Identity` and core stores none: 0053's "roles are a
policy vocabulary passed through" holds — the pass-through is now a
helper with a file format.

### 4. The change loop, per class of user

- **Admins** edit the program on desktop: checkpoints (0044), push, PR
  review on the code host. Store edits (an admin fixing a customer note)
  are direct, versioned writes, no commit.
- **Non-admins** never touch git. Store writes by their agent are direct
  and stamped. When they want the *program* changed ("this doc is wrong",
  "add a slide template"), their agent **proposes**: the serving host's
  bot credential opens a branch + PR carrying `on behalf of <user>`; admins
  review as usual. This is the "PR-equivalent" of the general-workspace
  vision, and it needs no per-user GitHub access.
- **External users** (customers) are unchanged from 0053: viewers of apps
  and published documents.

## Consequences

- One new concept (the project store) replaces three parked ones
  (publications' storage, blob storage, restricted artifacts); one new
  scope kind (`agent`) makes remote agent use by non-admins enforceable
  without new mechanisms; roles are files, so "tight access control" for
  a host is a resolver that calls one helper.
- The desktop shows the store as a **Documents** surface (per-path history,
  who wrote it) before any attempt to mount it into the file tree; agents
  reach it through `read_document` / `write_document` / `list_documents`
  tools narrowed by the session's effective scope.
- Build order:
  1. `agent` scope kind + scoped agent sessions (server): the piece the
     in-flight remote-agent work needs to be usable by non-admins.
  2. `roles/*.json` + `resolveRoles`; the embed skill's recipe uses it.
  3. Project store (service, routes, agent tools, Documents surface,
     document subtree refs, caller stamping on writes).
  4. `context.caller` in runs.
  5. Propose-a-change (bot PR on behalf of) on the CodeHost seam.
  6. Publications as `document` refs with a `public` audience.
- Open questions to settle before Accepted: whether the store root should
  be fixed (`store/`) or declared; whether writes by viewers need any
  review knob at all (current answer: no); whether `agent` refs should
  also carry per-caller tool narrowing beyond the intersection rule.
