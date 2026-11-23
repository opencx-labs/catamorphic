---
name: machines-hetzner
description: Connect your Work server machines to Hetzner Cloud.
---

# Machines on Hetzner Cloud

Pass `hetznerMachines({ token, defaults, userData })` beside your plan in
`hooks.machines`. Get the read-write cloud token from host secrets. Provide
a server type, location and boot image in `defaults`; a plan entry's
`options` can override them. Build user data with `machines-install`.
Use a deployment-specific tag or a dedicated Hetzner project. Test the
hook through `@catamorphic/work-server/testing`.
