# Existing or custom host

Preserve the application's working architecture unless the user asks to
change it. Catamorphic is mounted as libraries in the host process.

## Map the visible host

| Host concern | Catamorphic boundary |
| --- | --- |
| Verified session | `identity` resolver on `catamorphicPlugin` |
| Organization or workspace id | `tenantId` |
| Stable host user id | `externalUserId` |
| Host entitlements | scoped identity, or roles plus grants resolved by core |
| Postgres/PGlite | explicit `database` passed to `createCatamorphic` |
| Project files | explicit filesystem or remote storage backend |
| Execution | explicit sandbox/environment provider |
| UI session | host cookies or authorization transport on the API client |

Inspect the actual session verification function and membership lookup. The
identity resolver must use verified server-side values, never tenant or user
ids supplied by a browser request body or header.

Choose each dependency axis independently. A SaaS may use Postgres, object
storage, and cloud sandboxes. A trusted single-tenant internal app may use
PGlite, filesystem storage, and local processes. Do not infer the entire stack
from one axis.

Read `INTEGRATION.md` for current construction and mounting examples,
`packages/server-sdk/README.md` for the SDK surface, and
`packages/fastify-plugin/README.md` for request identity. The desktop boot at
`apps/desktop/src/main/server/boot.ts` is the reference embedded host.

Verify signed-out rejection, cross-tenant isolation, revoked membership,
schema migration, storage persistence, and the selected execution provider.
Add UI only if it is in scope and use the host's existing session transport
and design system.
