# Customization contract changes

This alpha deliberately changes the source and layout contract. Work's
`desktop_settings.authoring` metadata and `customization` reference/check/preview
operations describe the installed version. Existing project data is not converted
or uploaded by this change.

- Import source/layout types from `@catamorphic/work-customization`, using the
  installed declarations when checking existing code. Explicit source paths are
  checked even in hidden directories. Local copies of source interfaces can miss
  runtime differences.
- Source handlers receive `action: 'open'` with `mode: 'replace' | 'tab' | 'side' |
  'floating'`. Menus can still name opening choices. Code that handled only
  `open-here` or `open-side` in its handler uses `open` and forwards `mode` in its
  opening effect.
- Section-level row `menu`, `contextMenu`, `actions` and `open` fields are removed.
  Their location is `section.itemDefaults`; individual rows use their own fields,
  and `itemOverrides` applies last. Empty menus intentionally remove that placement.
  Section header controls remain in `headerActions`.
- Invalid visibility conditions now produce diagnostics. Fix the condition in the
  winning workspace layer rather than relying on it being silently omitted.
- Current surface/chat context is independent of `when`, which controls visibility.
  A contextual row is independent of the tree's keyboard focus. Use
  `contextualIndicator: 'row' | 'icon' | 'none'` and
  `descriptionVisibility: 'always' | 'hover'` for presentation.
- Standard opening entries compose once per mode and destination. Remove manual
  duplicate-opening workarounds; explicit menu overrides still replace their
  placement. Current context refreshes persistent lists without replacing their
  collection, focus or expansion. Use `when.session` only for chat-scoped data.
- Action `values` now use `SidebarInputValues`, including numbers, booleans and
  repeated named groups. Guard existing string operations with a type check.
  Native forms support select options, conditional fields, custom dates and
  repeatable scalar groups. The source still validates application rules.
- Inspector facts wrap and preserve label casing. Use fact `copy`, `actions`,
  `tone` and `display` instead of encoding these into labels. Rich prose uses
  `content.markdown`; interactive content uses an existing sandboxed project
  app via `content.app`, requiring `apps` in the source package's list grant
  and the app's own consent.
- Approval now identifies the canonical package location, project and profile.
  Existing per-file approvals require one new approval for the package's declared
  reach. Moving the package or widening its access requires another review.
- New host operations appear under `catamorphic.access.permissions`: `state`,
  `notifications`, `processes`, and `background`. Filesystem/network/workflow/list
  declarations remain independent. An existing approval cannot grant these by
  editing code alone.
- `work.call/start/run` shares the app workflow client. A private workflow's exact
  address is `private:<artifactId>:<revision>` in calls and the `workflows` grant.
  Private source pins are opaque SHA-256 snapshots, not Git commits; consumers of
  generic artifact `commitSha` fields must not assume 40 characters or Git access.
- Persistent reminders can use member-lifetime private workflow artifacts and
  ordinary enablements. Session watchers still end with their session. Saving,
  activating, updating the active revision and stopping are distinct operations.
- Private state uses conditional versioned writes. Source keys belong to the
  package; snapshots return `address` for an explicitly authorized workflow or
  agent to use through the canonical private-state service. Local files are not
  automatically migrated into this store.
- Application services run under a separate Work background runtime after the UI
  quits. They can restart after failure or engine transfer. View services end with
  their owning runtime. Resources Stop disables supervision as well as stopping
  the process. There is no promise of execution while the machine is powered off.
- macOS native sources and managed commands now run in one OS process. Raw
  subprocess creation, including detached children, is denied. A managed command
  can use `exec bun monitor.ts`; multi-process logic and npm tools run through an
  isolated workflow. Linux process trees stay inside their PID namespace.

The [complete reference](customization-reference.md) describes the current API.
