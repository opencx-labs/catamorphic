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

/** Every mirror file staged into (and read back from) the sandbox. */
const MIRROR_PATHS = [
  DESKTOP_CONFIG_SKILL_PATH,
  DESKTOP_KEYBINDINGS_WORKSPACE_PATH,
  DESKTOP_SIDEBAR_WORKSPACE_PATH,
  DESKTOP_SIDEBAR_LOCAL_WORKSPACE_PATH,
  DESKTOP_THEME_WORKSPACE_PATH,
];

export const DESKTOP_CONFIG_SKILL = `---
name: configuring-catamorphic-desktop
description: Change Catamorphic desktop app settings (keyboard shortcuts, the left sidebar's sections/items, and the color theme) when the user asks to customize the app itself, e.g. "rebind new chat to Cmd+N", "hide the workflows section", "add a Docs section with these links", "switch to the light theme", "make the accent purple".
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
${BUILTIN_ACTIONS.filter((action) => action.defaultBinding !== null)
  .map((action) => `- \`${action.id}\`: ${action.description}`)
  .join("\n")}

Binding format: zero or more modifiers (\`Cmd\`, \`Ctrl\`, \`Alt\`,
\`Shift\`) joined with \`+\`, then a key: \`"Cmd+T"\`,
\`"Cmd+Shift+P"\`, \`"Ctrl+Alt+N"\`. Single letters are uppercase; named
keys use their DOM name (\`Escape\`, \`F5\`, \`ArrowUp\`). Invalid
bindings are ignored and fall back to the default.

Warn the user if they pick a binding that collides with a common OS or
app shortcut (Cmd+Q, Cmd+C/V/X/A/Z, Cmd+N).

## Left sidebar

The sidebar is fully user-defined by a JS config file exporting an
ordered list of sections: the list IS the sidebar. Edit it to reorder,
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
\`bookmarks\`, \`git\` (uncommitted changes per git worktree; clicking a
file opens its diff), \`prs\` (the project's open pull requests), and the
legacy manual \`remote\` controls. Member views automatically omit
\`git\`, \`prs\`, and \`remote\`; builder views retain them.
Bookmarks are real browser bookmarks: the user creates them with the
star in the address bar; you never hand-write bookmark data here, you
only control how the section is presented.

Your own section:

\`\`\`js
{
  type: "custom",
  title: "Docs",
  open: "replace",
  items: [
    { label: "MDN", url: "https://developer.mozilla.org", icon: "Globe" },
  ],
}
\`\`\`

- \`open\`: \`"tab"\` (new browser tab) or \`"replace"\` (reuse the focused
  browser tab, falling back to a new tab). Set per section or per item.
- \`icon\`: any lucide-react icon name, e.g. \`"Globe"\`, \`"FileText"\`.
- \`preview\`: a compact hover card with optional \`title\`, \`description\`,
  and up to four \`metadata: [{ label, value }]\` rows. Set
  \`preview: false\` to explicitly disable it.
- \`collapsed: true\` starts a section collapsed.
- \`hideEmpty\`: hide the whole section (header included) while it has
  nothing to list. Defaults to true for \`workflows\` and \`apps\`, false
  for every other section; set it explicitly to override either way.

Hover menu (the ⋯ button on an item): set on a section (applies to all
its items) or on a single item:

\`\`\`js
menu: [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
  { label: "Delete", action: "remove", danger: true },
]
\`\`\`

Actions: \`open\`, \`open-tab\`, \`open-here\`, \`copy-url\`, \`pin\`,
\`unpin\`, \`rename\`, \`remove\`. \`menu: []\` removes the ⋯ button.
\`pin\`/\`unpin\`/\`rename\`/\`remove\` only do anything on bookmarks.

Rules: keep it valid JavaScript with a \`module.exports = { sections: [...] }\`.
It is evaluated in a sandbox: no \`require\`, no I/O, no async. An invalid
file falls back to the default sidebar, so verify your edit is syntactically
correct. Preserve the user's existing sections unless they asked otherwise,
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
      "segments": ["member"]
    }
  ]
}
\`\`\`

\`agent\` is an optional project-agent slug. \`segments\` is optional and
may contain \`"member"\`, \`"builder"\`, or \`"all"\`; omitting it shows the
action to both roles. Keep labels short and prompts complete enough to run
without another setup step.

## Color theme

The app's colors: \`${DESKTOP_THEME_WORKSPACE_PATH}\` (refreshed every
turn). Format:

\`\`\`json
{
  "selection": "system",
  "overrides": { "accent": "#7c5cff" }
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
