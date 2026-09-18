# 0146: Work application identity

- **Status:** Accepted
- **Date:** 2026-09-18
- **Supersedes:** Application identity in 0082 and cask names in 0085

## Context

Work is the end-user product at work.software, built on the Catamorphic
framework. Desktop and mobile should carry that identity consistently. The
project is greenfield alpha with no users, so a migration layer would add
complexity without serving a deployed population.

## Decision

Desktop and mobile are named **Work** and use the orange W mark. The macOS
bundle id is `software.work.desktop`; the app is `Work.app`, release assets
are `Work-<version>-arm64`, and Homebrew casks are `work` and `work@alpha`.
Work uses `work://connect` for credential-free invitations. The stock server,
desktop and mobile parsers emit and accept that locator together.

Electron uses `Work` for production and `Work Development` for isolated
unsigned development. The default project folder is `~/Work`. Application
support, logs, preferences and Keychain identity follow the new app name.
No old-identity aliases, imports or migration mechanisms are introduced.
Existing project folders can be imported explicitly.

Catamorphic remains the framework name: package scopes, library interfaces,
project `.catamorphic/` paths, development environment variables and internal
IPC identifiers remain framework contracts. Framework-owned resource links
such as `catamorphic://workflow/...` are distinct from Work invitations.
The repository, release tags, signed release procedure and update-channel
policy retain their existing contracts. This change does not publish a release.

## Consequences

The next signed release ships Work. Existing alpha downloads keep their
historical names until then. Installer verification, cask generation, product
copy, theme labels, mobile install icons and invitation tests change together.
