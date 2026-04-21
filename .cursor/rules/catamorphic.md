---
description: Catamorphic AI project conventions
globs: ["**/*.ts", "**/*.tsx"]
---

# Catamorphic AI Rules

- **Embed-first project.** Catamorphic is designed to be embedded inside host applications (e.g. OpenCX), not to run as a standalone product. Every architectural decision should assume a host app provides the user model, auth, database connection, and deployment surface. The standalone playground/server exist only for local development and demos — they are not the shipping target. When in doubt, favor designs that make embedding easier (configurable providers, injectable DB/schema, pluggable auth, no hard-coded env/paths) over designs that optimize for the standalone repo.
- Workflows are TypeScript code, not JSON. The parser (ts-morph) converts AST to WorkflowGraph.
- All step functions take a single destructured object parameter.
- Use JSDoc tags (@displayname, @icon, @description, @param) for UI metadata.
- Zod schemas are the single source of truth for API types.
- After adding API routes, regenerate: `bun run generate-spec && cd ../api-client && bun run generate`
- After migration changes: `bun run db:migrate && bun run db:codegen`
- Always typecheck with `tsgo` after changes.
- Never commit without explicit user request.
- Use objects as function parameters, not positional params.
- Avoid `any` type. Minimize mutable state.
