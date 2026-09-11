# @catamorphic/app

Guest runtime and host-themed UI components for sandboxed Catamorphic apps.

## Review components

Install the `code-review` source pack from the component registry and import the
local components. See [the registry](../registry/README.md) for installation and
adaptation. Review components are project source, not part of the guest runtime.

## App identity

`APP_ICON_NAMES`, `APP_ICON_DESCRIPTIONS`, and `resolveAppIcon` expose the
canonical semantic icon vocabulary. Hosts map these names to their icon library;
unknown values resolve to `default`. Agents use `set_app_presentation` to set a
title and/or icon without rebuilding. Every review uses `review`; uncertain
cases use `default`. Titles should be short and descriptive, with no required
template.
