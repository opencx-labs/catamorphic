# 0070: Default local Environment policy

- **Status:** Accepted
- **Date:** 2026-08-26
- **Refines:** 0064, 0066

## Context

Projects created before execution Environments were introduced have valid
manifests without an `environments` declaration. Imported repositories may
have no Catamorphic manifest at all. Rejecting the first agent message in
either case leaves the user with an error they cannot resolve through the
product.

Newly scaffolded projects already commit an explicit `local` Environment,
but older and imported projects need the same usable starting behavior without
silently rewriting their git history.

## Decision

When a project manifest is absent, or when a valid manifest omits the
`environments` property, Catamorphic resolves an implicit Environment policy
with:

- Environment name `local`
- host binding `local`
- agent and workflow workloads
- `local` as the default Environment

The fallback is a logical project policy only. The host still injects the
runtime binding and provider for `local`. Reading the fallback does not create,
modify, or commit a project manifest.

An explicitly present but malformed `environments` value remains invalid.
Newly scaffolded projects continue to commit the explicit policy so their
configuration is portable and visible.

## Consequences

Existing, imported, and cloned projects can start local work without a manual
manifest repair. Their repositories remain untouched. A host that does not
provide the `local` binding reports the narrower binding-unavailable error, and
projects that need another execution target must declare it explicitly.
