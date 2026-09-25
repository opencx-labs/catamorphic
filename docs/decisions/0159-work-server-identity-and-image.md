# 0159 — The Work server: product identity and a published image

- **Status:** Accepted
- **Date:** 2026-09-25
- **Refines:** 0059, 0146

## Context

ADR 0146 renamed the desktop and mobile apps to Work but left the prebuilt
server with the framework name: "Catamorphic server" pages, a
`catamorphic-<id>.local` hostname, `CATAMORPHIC_*` operator variables, and no
published image. Operators had to build the image from a checkout. The server
is an end-user product at work.software ("the company brain is self-hosted",
ADR 0145), and most installs will be set up by agents following the setup
skill, so the product name, its configuration, and its artifact must agree.

## Decision

The prebuilt server is the **Work server**. Everything an operator or member
sees carries that name: sign-in, consent, and landing pages with the W mark;
the boot banner; the default machine label; the `work-<id>.local` mDNS name;
the `work-server` telemetry service; and the setup skill, now
`skills/setup-work-server`.

Its deployment configuration uses the `WORK_` prefix (`WORK_DATA_DIR`,
`WORK_PUBLIC_URL`, `WORK_AUTH_CONFIG`, `WORK_SANDBOX`, and the rest), and the
deployment secret is `WORK_SECRET` instead of a variable named after the auth
library. The loopback setup listener serves `/_work/operator/*`. ADR 0146 kept
desktop development variables as framework contracts; server variables differ
because they are the operator's primary product interface. No old names are
accepted (greenfield, ADR 0146).

Framework contracts keep the Catamorphic name: `@catamorphic/*` packages, the
`.catamorphic/` project directory, the `catamorphic` and `catamorphic_auth`
database schemas, key-derivation labels, and workspace package names.

Every release tag (`desktop-v*`) publishes a multi-architecture `work-server`
image to the GitHub Container Registry of the repository owner, tagged with the
release version and `alpha`, plus `latest` for Stable releases, mirroring the
desktop channels. Each architecture builds natively, boots, and passes a smoke
test before publication; the manifest digest receives a signed build
provenance attestation. The image runs as the unprivileged `bun` user and
declares a health check.

Considered: a separate `server-v*` tag and version line. Rejected for now:
desktop and server speak one protocol and ship from one commit, so one version
tells a member which server matches their app.

## Consequences

Agents can install a pinned, attested image without a checkout. Operators who
built earlier images rename their variables when they upgrade. The package
must be made public once in the owner's GitHub package settings. Desktop,
mobile, and server now present one product; embedders still see only
Catamorphic.
