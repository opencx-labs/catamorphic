# @catamorphic/sdk

Library-direct SDK for embedding Catamorphic inside a host application.

The host imports this package, hands it the Kysely connection + `ProjectManager` it already has, and then calls catamorphic services in-process — no sidecar HTTP server required. All identity (host org id, host user id) is scoped per request via `cat.forTenant(orgId).forUser(userId)`.

## Install (inside the catamorphic monorepo)

```json
// host package.json
{
  "dependencies": {
    "@catamorphic/sdk": "workspace:*",
    "@catamorphic/db": "workspace:*",
    "@catamorphic/git": "workspace:*",
    "@catamorphic/sandbox": "workspace:*"
  }
}
```

## Usage

### Boot — once per process

```ts
import { createDatabase } from "@catamorphic/db";
import { ProjectManager, FsBackend, FsRemoteBackend } from "@catamorphic/git";
import { DaytonaSandboxProvider } from "@catamorphic/sandbox";
import { createCatamorphic } from "@catamorphic/sdk";

const db = createDatabase({
  connectionString: process.env.DATABASE_URL!,
  schema: "catamorphic", // catamorphic's schema inside the host DB
});

export const catamorphic = createCatamorphic({
  db,
  projectManager: new ProjectManager(
    new FsBackend(process.env.CATAMORPHIC_PROJECTS_PATH!),
    new FsRemoteBackend(process.env.CATAMORPHIC_REMOTES_PATH!),
  ),
  sandboxProvider: process.env.DAYTONA_API_KEY
    ? new DaytonaSandboxProvider({ apiKey: process.env.DAYTONA_API_KEY })
    : undefined,
});
```

### Per request — bind identity, then call resources

```ts
// req.org.id  — host's org id (becomes catamorphic.tenants.id)
// req.user.id — host's user id (used for per-user git working dirs + commit authorship)

const scoped = catamorphic
  .forTenant(req.org.id)
  .forUser(req.user.id);

const project = await scoped.projects.create({ name: "onboarding" });

await scoped.files.write(project.id, "src/welcome.ts", {
  content: welcomeTs,
  commitMessage: "Add welcome workflow",
});

const workflows = await scoped.workflows.list(project.id);
const graph = await scoped.workflows.get(project.id, "welcomeUser");
```

### v1 surface

```ts
scoped.projects.create({ name, templateId? })
scoped.projects.list({ limit?, offset? })
scoped.projects.get(projectId)
scoped.projects.update(projectId, { name? })
scoped.projects.delete(projectId)

scoped.workflows.list(projectId)
scoped.workflows.get(projectId, workflowName, { ref? })

scoped.files.list(projectId)
scoped.files.read(projectId, path)
scoped.files.readAll(projectId)
scoped.files.write(projectId, path, { content, commitMessage? })
```

Runs, plugins, secrets, and git ops (deploy/pull/diff) land in phase 2. For now, hosts that need those surfaces can either (a) call `cat.core.runs.*` / `cat.core.plugins.*` directly or (b) run `@catamorphic/server` and talk to it via `@catamorphic/api-client`.

## Identity model

- `tenantId` = host's org id. Auto-upserts `catamorphic.tenants(id)` on first project create, so hosts never need to pre-register orgs.
- `externalUserId` = host's user id. Never persisted in catamorphic's DB; used only for per-user git working directories and commit authorship.

Host can safely `JOIN host.orgs.id = catamorphic.projects.tenant_id` from its own side. Catamorphic never references host tables.

## Relationship to other packages

- `@catamorphic/core` — pure, non-HTTP service layer. This SDK is a thin ergonomic facade over `CatamorphicCore`.
- `@catamorphic/server` — Fastify HTTP surface. Hosts that prefer out-of-process embedding run the server and use `@catamorphic/api-client` instead of this SDK.
