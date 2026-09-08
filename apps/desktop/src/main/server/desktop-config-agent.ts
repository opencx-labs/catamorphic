import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  SandboxProvider,
  StartSessionOpts,
  TurnOptions,
} from "@catamorphic/sandbox";
import { BUILTIN_ACTIONS } from "../../shared/actions.js";
import {
  DEFAULT_KEYBINDINGS,
  type Keybindings,
  normalizeKeybindings,
} from "../keybindings.js";
import type { AppPrefs } from "../prefs.js";
import type { ProfileStores } from "../profile-config.js";
import type { SidebarConfigStore } from "../sidebar-config.js";
import { normalizeTheme, THEME_PRESETS, THEME_TOKENS } from "../theme.js";

export const DESKTOP_CONFIG_SKILL_PATH =
  ".agents/skills/configuring-catamorphic-desktop/SKILL.md";
export const DESKTOP_KEYBINDINGS_WORKSPACE_PATH =
  ".catamorphic/desktop/keybindings.json";
export const DESKTOP_SIDEBAR_WORKSPACE_PATH = ".catamorphic/desktop/sidebar.js";
export const DESKTOP_SIDEBAR_LOCAL_WORKSPACE_PATH =
  ".catamorphic/desktop/sidebar.local.js";
export const DESKTOP_THEME_WORKSPACE_PATH = ".catamorphic/desktop/theme.json";
export const DESKTOP_LAYOUT_WORKSPACE_PATH = ".catamorphic/desktop/layout.json";

/** Every mirror file staged into (and read back from) the sandbox. */
const MIRROR_PATHS = [
  DESKTOP_CONFIG_SKILL_PATH,
  DESKTOP_KEYBINDINGS_WORKSPACE_PATH,
  DESKTOP_SIDEBAR_WORKSPACE_PATH,
  DESKTOP_SIDEBAR_LOCAL_WORKSPACE_PATH,
  DESKTOP_THEME_WORKSPACE_PATH,
  DESKTOP_LAYOUT_WORKSPACE_PATH,
];

export const DESKTOP_CONFIG_SKILL = `---
name: configuring-catamorphic-desktop
description: Change Catamorphic desktop app settings (keyboard shortcuts, both sidebars' icon tabs and widgets, workspace tab placement, bookmarks, theme colors, and fonts) when the user asks to customize the app itself, e.g. "rebind new chat to Cmd+N", "hide the workflows section", "switch to the light theme", "make the accent purple", "change the interface font", "use Menlo for code".
---

# Configuring the Catamorphic desktop app

The user is talking to you from the Catamorphic desktop app. App-level
settings belong to the user's current profile (not to a project). You
change them by editing
mirror files under \`.catamorphic/desktop/\` in this workspace; the app
applies your edits the moment your turn ends. No restart needed: tell
the user the change is live. These mirror files never appear in the
user's project; they are configuration channels, not project files.

## Keyboard shortcuts

Current bindings: \`${DESKTOP_KEYBINDINGS_WORKSPACE_PATH}\` (refreshed at
the start of every one of your turns, so it always reflects reality).

To change bindings, edit that file, keeping ALL keys present:

\`\`\`json
${JSON.stringify(DEFAULT_KEYBINDINGS, null, 2)}
\`\`\`

Actions:
${BUILTIN_ACTIONS.map(
  (action) => `- \`${action.id}\`: ${action.description}`,
).join("\n")}

Binding format: zero or more modifiers (\`Cmd\`, \`Ctrl\`, \`Alt\`,
\`Shift\`) joined with \`+\`, then a key: \`"Cmd+T"\`,
\`"Cmd+Shift+P"\`, \`"Ctrl+Alt+N"\`. Single letters are uppercase; named
keys use their DOM name (\`Escape\`, \`F5\`, \`ArrowUp\`). Invalid
bindings are ignored and fall back to the default. An empty string disables
the shortcut while leaving the action available in the command palette.
Punctuation keys such as \`Cmd+[\` and \`Ctrl+;\` are supported.

Warn the user if they pick a binding that collides with a common OS or
app shortcut (Cmd+Q, Cmd+C/V/X/A/Z, Cmd+N).

## Sidebars

The sidebar is fully user-defined by a JS config file exporting an
object with left and right arrays of tabs. Each tab has id, title, icon and
sections. Each section has a stable id, unique across the layout, and type.
Edit it to reorder,
retitle, **hide** (delete the entry), or invent sections.

The config is LAYERED — the app uses the first of these that exists, so
pick the layer that matches what the user asked for:

1. \`${DESKTOP_SIDEBAR_LOCAL_WORKSPACE_PATH}\` — this user's view of THIS
   project only (mirror file, refreshed every turn; empty means no
   override exists yet — write a full config to create one).
2. \`.catamorphic/sidebar.js\` — the project's shared default. This is a
   NORMAL project file: edit it directly with your file tools, and it
   commits and syncs to the user's collaborators like any other file. It
   is never created automatically — a project that wants a shared layout
   opts in by creating it.
3. \`${DESKTOP_SIDEBAR_WORKSPACE_PATH}\` — this user's global fallback,
   used in any project without a more specific layer (mirror file,
   refreshed every turn).

"My sidebar", with no other context, usually means the most specific
layer that is in effect. A change meant for teammates too belongs in the
shared \`.catamorphic/sidebar.js\`; "just for me" / "just in this
project" belongs in \`sidebar.local.js\`.

Built-in section types: \`workflows\`, \`apps\`, \`chats\`, \`files\`,
\`bookmarks\`, \`tabs\` (open workspace tabs in sidebar mode), \`git\` (uncommitted changes per git worktree; clicking a
file opens its diff), \`prs\` (the project's open pull requests), and the
legacy manual \`remote\` controls. Views without a builder checkout omit
\`git\`, \`prs\`, and \`remote\`; builder views retain them.
Bookmarks are real browser bookmarks: the user creates them with the
star in the address bar; you never hand-write bookmark data here, you
only control how the section is presented.

Each side contains icon tabs: \`{ id: "project", title: "Project", icon: "House", sections: [...] }\`.
Preserve stable tab and section ids during edits; moving or reordering must not invent ids.
Either side may be empty. Move a tab or section by moving its definition between arrays.
Built-ins also include \`activity\` (running/attention sessions and workflow runs),
\`note\` (\`path: "docs/brief.md"\`, optional personal pin when omitted), and
\`app\` (\`app: "renewals", height: 320\`). App widgets are ordinary built project apps,
not inline JavaScript in this file. Build responsive compact content using host tokens.
Apps can import \`subscribeDisplay\` from \`@catamorphic/app\` to observe
\`{ mode: "compact" | "full", visible: boolean }\` and pause refreshes while hidden.
The sidebar mounts the same app with the same sandbox, storage and authorization;
expanding opens its full view. It grants no filesystem or active-chat access.

Your own section:

\`\`\`js
{
  id: "docs",
  type: "custom",
  title: "Docs",
  open: "replace",
  items: [
    { label: "MDN", url: "https://developer.mozilla.org", icon: "Globe" },
  ],
}
\`\`\`

- \`open\`: \`"replace"\` (open here), \`"tab"\`, \`"side"\`, or \`"floating"\`.
  Set per section or per item. Explicit gestures override this default:
  Cmd+click/Enter opens a tab, Cmd+Shift opens beside it, Option/Alt opens floating.
  Ctrl substitutes for Cmd outside macOS. Do not add a shortcut to float the current surface.
- \`icon\`: any lucide-react icon name, e.g. \`"Globe"\`, \`"FileText"\`.
- \`preview\`: a compact hover card with optional \`title\`, \`description\`,
  and up to four \`metadata: [{ label, value }]\` rows. Set
  \`preview: false\` to explicitly disable it.
- \`collapsed: true\` starts a section collapsed.
- \`hideEmpty\`: hide the whole section (header included) while it has
  nothing to list. Defaults to true for \`workflows\`, \`apps\`, \`git\` and \`remote\`, false
  for other sections; set it explicitly to override either way.
- \`when\`: on a section or custom item, target resolved project authority
  with optional \`builder: true|false\` and/or
  \`permissions: ["namespace:capability"]\`. Every condition must match;
  omit it to show the entry to everyone. Invalid targeting fails closed.

Hover menu (the ⋯ button on an item): set on a section (applies to all
its items) or on a single item:

\`\`\`js
menu: [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
  { label: "Delete", action: "remove", danger: true },
]
\`\`\`

Actions: \`open\`, \`open-tab\`, \`open-here\`, \`open-side\`, \`open-floating\`, \`copy-url\`, \`pin\`,
\`unpin\`, \`rename\`, \`edit\` (bookmark address and folder), \`remove\`.
Resource menus always include the four opening choices; \`menu: []\` removes only extra actions.
\`pin\`/\`unpin\`/\`rename\`/\`remove\` only do anything on bookmarks.

Rules: keep it valid JavaScript with a \`module.exports = { left: [...], right: [...] }\`.
It is evaluated in a sandbox: no \`require\`, no I/O, no async. An invalid
file retains the last valid layout and shows an error. Preserve the user's existing sections unless they asked otherwise,
and keep the explanatory comments at the top intact.

## Project New Tab actions

A project may add up to six small starting actions to the ordinary New Tab
palette through \`.catamorphic/project.json\`. They are absent when the
project does not configure them. Preserve the rest of the manifest:

\`\`\`json
{
  "startingActions": [
    {
      "label": "Prepare customer briefing",
      "prompt": "Prepare the customer briefing from the company context.",
      "agent": "csm",
      "when": {
        "builder": false,
        "permissions": ["briefings:prepare"]
      }
    }
  ]
}
\`\`\`

\`agent\` is an optional project-agent slug. \`when\` is optional; it may match
\`builder: true|false\` and require a list of namespaced project role
permissions. Every condition must match. Omitting it shows the action to
everyone. Invalid targeting fails closed. Keep labels short and prompts
complete enough to run without another setup step.

## Theme colors and fonts

The app's colors and fonts: \`${DESKTOP_THEME_WORKSPACE_PATH}\` (refreshed every
turn). Format:

\`\`\`json
{
  "selection": "system",
  "overrides": { "accent": "#7c5cff" },
  "fonts": { "sans": "Arial, sans-serif", "mono": "Menlo, monospace" }
}
\`\`\`

Selections: \`system\` (follows the operating system with Catamorphic Light
and Catamorphic Dark), ${THEME_PRESETS.map((preset) => `\`${preset.id}\` (${preset.label})`).join(", ")}.
\`overrides\` replaces individual colors on top of the preset, and any CSS
color works. Tokens:
${THEME_TOKENS.map((token) => `\`${token}\``).join(", ")}.

Unknown selections, tokens, or invalid colors are ignored. Keep overrides
minimal (prefer picking the closest preset); when changing surface colors,
keep enough contrast with the text tokens.

\`fonts.sans\` sets the interface and body font; \`fonts.mono\` sets code,
logs, editors, diffs, and terminals. Embedded apps using the host's theme
tokens inherit these choices live too. Use installed font family names,
optionally quoted, with comma-separated fallbacks. End with a generic family
such as \`sans-serif\` or \`monospace\`. Missing fonts fall back to the next
family; this setting does not download or install fonts. URLs and CSS
functions or declarations are not accepted.

Omit or remove a font key to restore its default: Inter for \`sans\`,
JetBrains Mono for \`mono\`, each with system fallbacks. Preserve the other
font key and existing colors when changing one font; preserve \`fonts\` when
changing only colors. Fonts are also editable in Settings under Theme.
## Workspace layout

Edit \`${DESKTOP_LAYOUT_WORKSPACE_PATH}\` to set \`tabPlacement\` to
\`"top"\` or \`"sidebar"\`, and \`pinnedBookmarks\` to \`"tiles"\` or
\`"list"\`. Set \`headerPlacement\` to \`"sidebar"\` for the full Arc layout,
or \`"top"\` for a title-only header above the content. All apply live to the current profile. These are independent
of the color theme and sidebar section order. Sidebar mode always keeps
tabs out of the header, including while the
sidebar is collapsed. The header shows the active title or browser address
controls; keyboard shortcuts and the palette still reach every open tab.
The collapse control lives in the sidebar, and an empty New Tab page leaves
the header blank. To match the light
browser layout, choose the light theme, sidebar tabs, pinned tiles, and
put the bookmarks section first. The \`sidebar\` color token controls the
sidebar and surrounding window frame. The profile switcher stays at the
bottom. Bookmarks and folders can be added or edited in the sidebar;
removing a folder keeps its bookmarks at the root.

## Other app settings

AI agents (harness, model, effort, API keys, accounts) are configured in
the app's Settings screen or the command palette. Credentials are
OS-keychain encrypted and cannot be edited from here. If the user asks
about those, point them to Settings.
`;

/**
 * Wraps the real coding agent to make the desktop app itself configurable
 * from a chat. Before every turn it stages a skill (HOW to configure) and a
 * fresh keybindings mirror (CURRENT state) into the sandbox; after every
 * turn it reads the mirror back and applies any edit to the real
 * keybindings file. Staged and applied states are committed to the sandbox
 * git baseline so mirrors never sync into the user's project as drafts.
 */
export class DesktopConfigAgent implements CodingAgentProvider {
  readonly name: string;

  /** Forwarded only when the harness supports them (feature-detection). */
  readonly interrupt?: (providerSessionId: string) => void;
  readonly hasSession?: (providerSessionId: string) => boolean;
  readonly retryTurn?: CodingAgentProvider["retryTurn"];

  constructor(
    private readonly inner: CodingAgentProvider,
    private readonly sandboxProvider: SandboxProvider,
    /** Config is per profile; the session's project names the profile. */
    private readonly storesFor: (projectId?: string) => ProfileStores,
    /** This user's project-local sidebar override (sidebar.local.js). */
    private readonly projectSidebarFor: (
      projectId: string,
    ) => SidebarConfigStore,
  ) {
    this.name = inner.name;
    if (inner.interrupt) {
      this.interrupt = (providerSessionId) =>
        inner.interrupt?.(providerSessionId);
    }
    if (inner.hasSession) {
      this.hasSession = (providerSessionId) =>
        inner.hasSession?.(providerSessionId) ?? true;
    }
    if (inner.retryTurn) {
      // Retries get the same stage/apply bracketing as regular turns.
      const innerRetry = inner.retryTurn.bind(inner);
      const self = this;
      this.retryTurn = async function* (session, opts) {
        await self.stage(session);
        try {
          yield* innerRetry(session, opts);
        } finally {
          await self.applyEdits(session);
        }
      };
    }
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    const session = await this.inner.startSession(opts);
    await this.stage(session);
    return session;
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    await this.stage(session);
    try {
      yield* this.inner.sendMessage(session, message, opts);
    } finally {
      // Runs before core's draft sync (we're still inside its for-await),
      // so applied mirrors are committed and never become project drafts —
      // even when the inner turn errors out.
      await this.applyEdits(session);
    }
  }

  dispose(session: ProviderSession): Promise<void> {
    return this.inner.dispose(session);
  }

  private stores(session: ProviderSession): ProfileStores {
    return this.storesFor(session.projectId);
  }

  private async stage(session: ProviderSession): Promise<void> {
    // Host-execution sessions have no sandbox to stage mirrors into.
    if (!session.sandboxId) return;
    try {
      const stores = this.stores(session);
      const prefs = stores.prefs.load();
      await this.sandboxProvider.uploadFiles(
        session.sandboxId,
        {
          [DESKTOP_CONFIG_SKILL_PATH]: DESKTOP_CONFIG_SKILL,
          [DESKTOP_KEYBINDINGS_WORKSPACE_PATH]: `${JSON.stringify(
            stores.keybindings.load(),
            null,
            2,
          )}\n`,
          [DESKTOP_SIDEBAR_WORKSPACE_PATH]: stores.sidebar.read(),
          // Empty when the project has no local override (or the session
          // has no project): the mirror must not fake one into existence.
          [DESKTOP_SIDEBAR_LOCAL_WORKSPACE_PATH]:
            this.localSidebarSource(session),
          [DESKTOP_THEME_WORKSPACE_PATH]: `${JSON.stringify(
            stores.theme.load(),
            null,
            2,
          )}\n`,
          [DESKTOP_LAYOUT_WORKSPACE_PATH]: `${JSON.stringify({ tabPlacement: prefs.tabPlacement, headerPlacement: prefs.headerPlacement, pinnedBookmarks: prefs.pinnedBookmarks }, null, 2)}\n`,
        },
        session.workingDirectory,
      );
      await this.commitMirrors(session, "sync desktop config snapshot");
    } catch (cause) {
      // Config staging must never break a chat turn.
      console.warn("[desktop] Failed to stage desktop config:", cause);
    }
  }

  /** Pull the agent's mirror edits (if any) into the real config. */
  private async applyEdits(session: ProviderSession): Promise<void> {
    if (!session.sandboxId) return;
    // Each mirror applies independently: a broken sidebar edit must not
    // swallow a valid keybindings edit made in the same turn.
    await this.applyKeybindings(session);
    await this.applySidebar(session);
    await this.applySidebarLocal(session);
    await this.applyTheme(session);
    await this.applyLayout(session);
    try {
      // Commit even when unchanged: an agent edit that normalizes to the
      // current state must still not sync back as a project draft.
      await this.commitMirrors(session, "apply desktop config");
    } catch (cause) {
      console.warn("[desktop] Failed to commit desktop config:", cause);
    }
  }

  private async applyKeybindings(session: ProviderSession): Promise<void> {
    try {
      const raw = await this.sandboxProvider.downloadFile(
        session.sandboxId,
        `${session.workingDirectory}/${DESKTOP_KEYBINDINGS_WORKSPACE_PATH}`,
      );
      const store = this.stores(session).keybindings;
      const next = normalizeKeybindings(JSON.parse(raw));
      if (!sameBindings(next, store.load())) {
        // save() rewrites keybindings.json; the file watcher applies it
        // live (menu rebuild + renderer broadcast).
        store.save(next);
      }
    } catch (cause) {
      console.warn("[desktop] Failed to apply keybindings edits:", cause);
    }
  }

  private async applySidebar(session: ProviderSession): Promise<void> {
    try {
      const source = await this.sandboxProvider.downloadFile(
        session.sandboxId,
        `${session.workingDirectory}/${DESKTOP_SIDEBAR_WORKSPACE_PATH}`,
      );
      const store = this.stores(session).sidebar;
      if (source.trim() === "" || source === store.read()) return;
      // Refuse a config that doesn't evaluate to sections: writing it would
      // silently collapse the user's sidebar to the defaults.
      if (!store.isValidSource(source)) {
        console.warn("[desktop] Ignoring invalid sidebar.js from agent");
        return;
      }
      // write() triggers the file watcher, which reloads and broadcasts.
      store.write(source);
    } catch (cause) {
      console.warn("[desktop] Failed to apply sidebar edits:", cause);
    }
  }

  /** The staged content of the project-local override mirror. */
  private localSidebarSource(session: ProviderSession): string {
    if (!session.projectId) return "";
    const store = this.projectSidebarFor(session.projectId);
    return store.exists() ? store.read() : "";
  }

  private async applySidebarLocal(session: ProviderSession): Promise<void> {
    if (!session.projectId) return;
    try {
      const source = await this.sandboxProvider.downloadFile(
        session.sandboxId,
        `${session.workingDirectory}/${DESKTOP_SIDEBAR_LOCAL_WORKSPACE_PATH}`,
      );
      const store = this.projectSidebarFor(session.projectId);
      const current = store.exists() ? store.read() : "";
      // Empty is the staged "no override" state, never a deletion request.
      if (source.trim() === "" || source === current) return;
      // Same guard as the global mirror: a config that doesn't evaluate to
      // sections would silently collapse the sidebar to the defaults.
      if (!store.isValidSource(source)) {
        console.warn("[desktop] Ignoring invalid sidebar.local.js from agent");
        return;
      }
      // The layer watchers (registered when this project's config was
      // first resolved) pick the write up and broadcast the change.
      store.write(source);
    } catch (cause) {
      console.warn("[desktop] Failed to apply project sidebar edits:", cause);
    }
  }

  private async applyTheme(session: ProviderSession): Promise<void> {
    try {
      const raw = await this.sandboxProvider.downloadFile(
        session.sandboxId,
        `${session.workingDirectory}/${DESKTOP_THEME_WORKSPACE_PATH}`,
      );
      const store = this.stores(session).theme;
      const next = normalizeTheme(JSON.parse(raw));
      if (JSON.stringify(next) !== JSON.stringify(store.load())) {
        // save() rewrites theme.json; the file watcher applies it live
        // (window background + renderer broadcast).
        store.save(next);
      }
    } catch (cause) {
      console.warn("[desktop] Failed to apply theme edits:", cause);
    }
  }

  private async applyLayout(session: ProviderSession): Promise<void> {
    try {
      const raw: unknown = JSON.parse(
        await this.sandboxProvider.downloadFile(
          session.sandboxId,
          `${session.workingDirectory}/${DESKTOP_LAYOUT_WORKSPACE_PATH}`,
        ),
      );
      if (typeof raw !== "object" || raw === null) return;
      const patch: Partial<AppPrefs> = {};
      if (
        "tabPlacement" in raw &&
        (raw.tabPlacement === "top" || raw.tabPlacement === "sidebar")
      )
        patch.tabPlacement = raw.tabPlacement;
      if (
        "pinnedBookmarks" in raw &&
        (raw.pinnedBookmarks === "tiles" || raw.pinnedBookmarks === "list")
      )
        patch.pinnedBookmarks = raw.pinnedBookmarks;
      if (
        "headerPlacement" in raw &&
        (raw.headerPlacement === "top" || raw.headerPlacement === "sidebar")
      )
        patch.headerPlacement = raw.headerPlacement;
      const store = this.stores(session).prefs;
      const current = store.load();
      if (
        (patch.tabPlacement !== undefined &&
          patch.tabPlacement !== current.tabPlacement) ||
        (patch.pinnedBookmarks !== undefined &&
          patch.pinnedBookmarks !== current.pinnedBookmarks) ||
        (patch.headerPlacement !== undefined &&
          patch.headerPlacement !== current.headerPlacement)
      )
        store.save(patch);
    } catch (cause) {
      console.warn("[desktop] Failed to apply layout edits:", cause);
    }
  }

  private async commitMirrors(
    session: ProviderSession,
    message: string,
  ): Promise<void> {
    const paths = MIRROR_PATHS.map((mirror) => `'${mirror}'`).join(" ");
    await this.sandboxProvider.executeCommand(
      session.sandboxId,
      `cd '${session.workingDirectory}' && ` +
        `git add ${paths} && ` +
        `(git diff --cached --quiet -- ${paths} || ` +
        `git -c user.name=catamorphic -c user.email=desktop@catamorphic.local ` +
        `commit -q -m '${message}')`,
    );
  }
}

function sameBindings(a: Keybindings, b: Keybindings): boolean {
  return Object.keys(a).every(
    (key) => a[key as keyof Keybindings] === b[key as keyof Keybindings],
  );
}
