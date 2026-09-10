# 0117: Optional GitHub CLI connection

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

PR operations silently used the machine's GitHub CLI login even though Settings
showed separate connector state. The user requested CLI as an optional connection.

## Decision

Settings > Connections offers an explicit GitHub CLI connection, disabled by default
and persisted per desktop profile. Connecting verifies the CLI account before enabling
it. The profile preference gates PR list, files, details, comments, and automatic CLI
credential fallback for repository access. Disconnect never runs gh auth logout.

The PR empty state links directly to connection settings. Changes to the preference
reload the inbox. Credentials stay in the main process and are never returned to the
renderer. MCP connections continue to supply agent tools; this change does not claim
that arbitrary MCP servers implement the desktop PR provider contract.

## Consequences

An installed CLI no longer implicitly grants the PR view access. Existing profiles
must explicitly enable this option. GitHub App connections and stored repository
credentials retain their existing independent lifecycle. A unified MCP review adapter
remains separate work and must validate supported operations before being offered.
