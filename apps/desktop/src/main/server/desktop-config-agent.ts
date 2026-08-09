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
import { normalizeTheme, THEME_PRESETS, THEME_TOKENS } from "../theme.js";

export const DESKTOP_CONFIG_SKILL_PATH =
  ".agents/skills/configuring-catamorphic-desktop/SKILL.md";
export const DESKTOP_KEYBINDINGS_WORKSPACE_PATH =
  ".catamorphic/desktop/keybindings.json";
export const DESKTOP_SIDEBAR_WORKSPACE_PATH = ".catamorphic/desktop/sidebar.js";
export const DESKTOP_THEME_WORKSPACE_PATH = ".catamorphic/desktop/theme.json";

/** Every mirror file staged into (and read back from) the sandbox. */
const MIRROR_PATHS = [
  DESKTOP_CONFIG_SKILL_PATH,
  DESKTOP_KEYBINDINGS_WORKSPACE_PATH,
  DESKTOP_SIDEBAR_WORKSPACE_PATH,
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

The sidebar is fully user-defined: \`${DESKTOP_SIDEBAR_WORKSPACE_PATH}\`
(also refreshed every turn). It is a real JS file exporting an ordered
list of sections: the list IS the sidebar. Edit it to reorder, retitle,
**hide** (delete the entry), or invent sections.

Built-in section types: \`workflows\`, \`apps\`, \`chats\`, \`bookmarks\`.
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
- \`collapsed: true\` starts a section collapsed.

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

## Color theme

The app's colors: \`${DESKTOP_THEME_WORKSPACE_PATH}\` (refreshed every
turn). Format:

\`\`\`json
{
  "preset": "dark",
  "overrides": { "accent": "#7c5cff" }
}
\`\`\`

Presets: ${THEME_PRESETS.map((preset) => `\`${preset.id}\` (${preset.label})`).join(", ")}.
\`overrides\` replaces individual colors on top of the preset, and any CSS
color works. Tokens:
${THEME_TOKENS.map((token) => `\`${token}\``).join(", ")}.

Unknown presets, tokens, or invalid colors are ignored. Keep overrides
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
