# 0055 — Company brain: program vs. store, roles as files, scoped agents, the change loop

- **Status:** Accepted
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
  the gitignored `store/` subtree of the project, so a path is
  unambiguous: under `store/` it is store-backed, otherwise git.

The store root is **fixed at `store/`** (a knob we can add later if a
case demands it). **Backends:** paths, versions, `written_by`, text
content and the search index always live in the project DB — that is
what keeps history, search and scope enforcement uniform. Only blob
bytes are pluggable, behind the small `ObjectStore` interface ADR 0012
already has: Postgres (default, zero config), local filesystem
(desktop-local projects, single-box servers, NFS mounts), S3-compatible
(R2/S3/MinIO, the production shape, client already in `@catamorphic/s3`).
Google Drive, Dropbox, SharePoint and the like are **not backends**:
their ACLs would fight ours and their versioning is not ours. They are
connectors — sources the brain reads via MCP/workflows, mirrored into the
store when needed. Store content is versioned per write (a linear history
per path, not branches) and never needs a deploy. It is what publications publish (a
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

### 2. Access control: the host owns *who*, Catamorphic owns *what* and *enforcement* — as in 0053, with four extensions

`Identity.scope` stays the only enforcement vocabulary. It grows:

```ts
type ArtifactRef =
  | { kind: "project"; projectId }            // NEW: builder — full program access
  | { kind: "app"; projectId; name; channel? }
  | { kind: "workflow"; projectId; name }
  | { kind: "document"; projectId; path; access?: "read" | "write" }  // "/**" = subtree
  | { kind: "agent"; projectId; name; toolPolicies? };  // NEW: a project agent (0050) by slug
```

- **Builder is an explicit ref, and the store is reachable only through
  document refs — for builders too.** "Admin" is two separate grants:
  editing the program (`project` ref: files, deploys, secrets, agent
  definitions, every workflow/app/agent) and seeing store subtrees
  (`document` refs). Some data must stay hidden from some admins, and a
  builder cloning the git repo sees the whole *program* anyway; keeping
  the store on its own ACL is what makes that possible. `scope` absent
  remains only for the **root identity**: the desktop's own local
  projects and a host's service identity.

- **Agents are artifacts.** A scoped identity may open sessions on the
  agents its scope names, and on nothing else. `assertFullIdentity` stops
  guarding agent sessions; `narrowIdentity` to the agent ref guards them
  instead, exactly as app routes do. Inside such a session, **the caller's
  scope intersects the agent's tool policy** (0054's rule extended by one
  layer): the agent may read only store paths, call only workflows, and
  mount only apps that both its definition and the caller's scope allow.
  A CSM's agent literally cannot read another CSM's customers, whatever
  the model is told. When the same persona must reach differently per
  role (seniors may post to Slack, juniors may not; a role must confirm
  before `crm.update`), the ref carries `toolPolicies` (0054's shape,
  keyed by connector or `catamorphic` for workflows) as **one more
  intersecting layer** — it can only narrow, never enters the consent
  hash, teaches harnesses nothing new. Genuinely different personas are
  still two agents; the ref is for same-persona, different-reach.
- **Document refs cover subtrees.** `customers/acme/**` grants a folder,
  in git (deployed commit, always read-only through this ref) or in the
  store (read or write per the ref's `access`, default read). No review
  knob on store writes: they are data, not program, and the stamp is the
  audit.
- **Every write and every run is stamped with the caller.** Store writes
  carry `written_by`; runs carry the triggering identity server-side and
  expose it as `context.caller` in `BoundaryContext` (never in `input`,
  which is author-typed). This is the audit trail, and what lets one
  shared workflow isolate per caller without trusting its input.
- **Search: core ships the tree primitives, projects ship opinions.**
  Core provides `list` (glob), `read`, `grep`/full-text over git paths
  (the deployed checkout) and store paths (Postgres FTS), scope-filtered
  at the source. Semantic search — embeddings, chunking, model, cost — is
  a project workflow exposed as a tool. To keep that safe by construction
  workflows touch documents only through a **caller-bound handle**,
  `context.documents`, whose every read/list/search is narrowed to
  `context.caller`'s scope; a project author cannot leak what the caller
  may not see, whether or not they remember to filter. A host-tier skill
  (0052 framework set, `searching-documents`) carries the recipe:
  primitives first, then a Postgres-resident FTS + vector index (AI SDK
  embeddings, indexed on store write, read through `context.documents`);
  it is backend-independent because the index never lives in the blob
  backend.
- **Caller-bound host functions generalize `context.documents`.**
  Capability providers (0046) gain a second form beside env `resolve`:
  `defineCapability({ name: "acme.crm", calls: { lookupCustomer: async
  (caller, args) => … } })`, exposed to workflow code as
  `context.host.acme.crm.lookupCustomer(args)`, typed through the
  generated projections (0041). Core attaches `caller` from the run
  record — a workflow cannot claim to be anyone — and each host call is
  a **durable boundary** (0020/0023) like `callWorkflow`: recorded,
  replay-safe, in the run timeline. Since workflow code runs in a
  runtime, host functions are an RPC back to the host regardless; the
  boundary is where that RPC lives. `context.documents` is the first
  built-in such capability.

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
with unfilled placeholders grants nothing for that entry. `"builder":
true` on a role emits the `project` ref; an admin role that may see the
whole store says so with `store/**`, and one that may not, doesn't.

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

**Membership is the one piece every host would rebuild identically, so it
ships as an optional stock table + service** (`MembershipsService`:
`grant`, `revoke`, `list`, `identityFor(projectId, tenantId,
externalUserId)` = membership row → `resolveRoles`), in the family of the
existing `tenant-policies-service`. Core still holds no policy: the table
is a stock *source* of `roles`/`grants` that a host may use or ignore
(hosts with their own entitlements call `resolveRoles` directly). This is
what makes invitation recipe-sized for the coding agent building a host:

```ts
// the resolver — the host's auth, then one line
identity: async (req) => { const u = await verifyToken(req); return u && memberships.identityFor(projectId, u.tenantId, u.id); }
// an invite — one call, then the host sends its own link
await memberships.grant({ projectId, tenantId, externalUserId, roles: ["csm"], grants: { customer: ["acme"] } });
```

Who the user *is* (signup, SSO, token issuance, the invite email) stays
the host's. The invite link the host sends is a **connect link** —
`catamorphic://connect?server=<api base>&token=…` (or a plain URL to the
host's own UI) — that the desktop understands; the host's identity
resolver verifies the bearer token, and `identityFromBearer(verify)` is
the stock resolver for that. Token lifetime, refresh and revocation are
host concerns and revocation is instant by construction: every request
re-resolves.

### 3b. Not only the desktop: one MCP endpoint per project, narrowed by identity

`/api/projects/:id/mcp` serves the caller's whole scope as MCP: documents
(`list`/`read`/`write`/`search`, store and git paths alike), workflows as
tools (0042), skills (`read_skill`, 0052), and project agents as
"ask <agent>" tools. It is the existing workflow-tools and apps MCP
surfaces generalized into the single "bring your own agent" door — Claude
Code, Cursor, or a host's own assistant connect to it with the same
token the desktop uses, and see exactly what the desktop would show that
user. Being invited *is* receiving this URL.

### 3c. The desktop for a hosted user: a local working copy of the scoped tree

Project = folder still holds. The backend serves the scoped tree as one
file surface (program paths at the deployed commit, store subtrees in
scope, each file with a version) and the desktop syncs it into a folder:

- Builders with code-host access keep **git for the program** (0044:
  checkpoints, push, PRs) and **store sync for `store/`**.
- Everyone else gets program paths **materialized read-only** and store
  paths **read/write**, both over the file surface — no git anywhere in
  their experience.

The file explorer shows one tree, local agents (ours, or the user's own
via the MCP endpoint) edit locally, and **ship** = push store paths with a
version check (last write wins on match; on mismatch keep both and say
so — linear history, no branches, no merge UI) plus, for program edits, a
checkpoint+push (builders) or a proposal (below). Store paths are
gitignored, so a builder's git tree never carries hidden data. This
replaces the "Documents surface" idea: the store is `store/` in the tree
with per-file history and author.

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
- The desktop gains one concept, the **remote project**: a folder synced
  from a backend's scoped file surface, opened from a connect link. Local
  projects are unchanged and keep the root identity.
- Build order:
  1. `project` + `agent` scope kinds; scoped agent sessions on the server
     (caller scope ∩ agent tool policy): what the in-flight remote-agent
     work needs to be usable by non-admins.
  2. `roles/*.json` + `resolveRoles`; `MembershipsService`;
     `identityFromBearer`; the embed skill's recipe rewritten around them.
  3. Project store: service + versions + blob backend, the scoped file
     surface (list/read/write/grep with versions), document subtree refs
     with `access`, `written_by` stamping; `context.caller` +
     `context.documents` in `BoundaryContext`; capability `calls`
     (caller-bound host functions as durable boundaries); the
     `searching-documents` host-tier skill.
  4. The project MCP endpoint over the file surface + workflows + skills
     + agents.
  5. Desktop remote projects: connect link, sync, ship, per-file history.
  6. Propose-a-change (bot PR on behalf of) on the CodeHost seam;
     publications as `document` refs with a `public` audience.
