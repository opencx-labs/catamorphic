/** Short host facts; complete tested contracts are installed beside the SDK. */
export const WORKSPACE_AUTHORING_GUIDE = `## Work customization

Workspace layouts place sources, static links, apps and notes in sidebar tabs;
palette modes and chat chips can use the same sources. Layouts are data-only
CommonJS JavaScript. Source modules are ordinary TypeScript. Work's own lists
and custom lists use the same row and action contracts.

The desktop_settings response identifies the owning profile, exact files,
winning workspace layer, validation errors and installed authoring tools.
Its authoring.types and authoring.reference describe the running version;
authoring.commands.check checks explicit source and layout files, including
hidden folders. The customization capability provides the reference, static
checks and a preview under the same confinement as live sources.

Workspace precedence is built-in, profile, shared project, personal project.
Each workspace file replaces the document at the lower layer. Row presentation
is source row, then itemDefaults, then itemOverrides. Header actions belong to
the section. Current surface and optional chat context are independent of when,
which controls visibility. Opening intent reaches a handler as open plus mode.

A source supplies load, optional subscribe, action, move, drop and reveal.
Native rows supply navigation, keyboard controls, menus, loading, empty states,
errors, drag-and-drop and theme. Subscriptions exist while observed. Workflows
and explicitly enabled application processes have independent lifetimes.
The package's access declaration describes what its code can reach; one signed
approval covers its entry points, and wider access asks again. Credentials stay
in authorized workflows and host operations.

Work sidebars are narrow, with native 28px rows. Short labels usually leave more
room for content; previews and hover/focus descriptions hold secondary details.
Quiet lists normally need no status rows or routine success messages. These are
starting points, not restrictions on a person's design.
`;
