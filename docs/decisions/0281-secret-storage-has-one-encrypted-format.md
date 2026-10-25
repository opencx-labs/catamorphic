# 0281 - Secret storage has one encrypted format

- **Status:** Accepted
- **Date:** 2026-10-25
- **Amends:** 0162, 0206

## Context

The secret-management security review found plaintext fallbacks and migration
paths alongside the encrypted stores. The user explicitly chose breaking alpha
changes over preserving legacy formats, with company-brain deployments the
priority.

## Decision

Persisted project secrets require a host-injected credential vault. Database
rows hold a non-null vault reference and no value column. Missing encryption
refuses a write; it never selects plaintext storage. Existing plaintext rows
are unsupported: the schema change refuses them without deleting their values.

Encrypted vault envelopes require their key id and the current authenticated
format. Previous keys remain an explicit rotation facility, not format
compatibility. A server using configured keys does not implicitly add a local
key file. Desktop agent and connection stores accept encrypted credentials
only; plaintext import and migration paths are removed.

## Consequences

One storage model can be audited. Embedders without a vault can still use
projects, workflows and apps, but cannot store secret values. Alpha installs
with unsupported plaintext records require explicit operator recovery before
upgrading; startup never silently discards credentials or rewrites corrupt
vaults. Historical schema migrations remain immutable.
