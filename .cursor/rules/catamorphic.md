---
description: Catamorphic AI project conventions
globs: ["**/*.ts", "**/*.tsx"]
---

# Catamorphic AI Rules

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
