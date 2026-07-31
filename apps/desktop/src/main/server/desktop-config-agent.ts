import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  SandboxProvider,
  StartSessionOpts,
} from "@catamorphic/sandbox";
import {
  type Keybindings,
  type KeybindingsStore,
  normalizeKeybindings,
} from "../keybindings.js";

export const DESKTOP_CONFIG_SKILL_PATH =
  ".agents/skills/configuring-catamorphic-desktop/SKILL.md";
export const DESKTOP_KEYBINDINGS_WORKSPACE_PATH =
  ".catamorphic/desktop/keybindings.json";

export const DESKTOP_CONFIG_SKILL = `---
name: configuring-catamorphic-desktop
description: Change Catamorphic desktop app settings (keyboard shortcuts) when the user asks to customize the app itself, e.g. "rebind new chat to Cmd+N" or "change my shortcuts".
---

# Configuring the Catamorphic desktop app

The user is talking to you from the Catamorphic desktop app. App-level
settings are user-global (not per project). You change them by editing
mirror files under \`.catamorphic/desktop/\` in this workspace; the app
applies your edits the moment your turn ends. No restart needed — tell
the user the change is live. These mirror files never appear in the
user's project; they are configuration channels, not project files.

## Keyboard shortcuts

Current bindings: \`${DESKTOP_KEYBINDINGS_WORKSPACE_PATH}\` (refreshed at
the start of every one of your turns, so it always reflects reality).

To change bindings, edit that file, keeping ALL keys present:

\`\`\`json
{
  "new-chat": "Cmd+T",
  "toggle-sidebar": "Cmd+B",
  "close-tab": "Cmd+W"
}
\`\`\`

Actions: \`new-chat\` (open a new chat tab), \`toggle-sidebar\`,
\`close-tab\` (closes the focused chat or tab).

Binding format: zero or more modifiers (\`Cmd\`, \`Ctrl\`, \`Alt\`,
\`Shift\`) joined with \`+\`, then a key: \`"Cmd+T"\`,
\`"Cmd+Shift+P"\`, \`"Ctrl+Alt+N"\`. Single letters are uppercase; named
keys use their DOM name (\`Escape\`, \`F5\`, \`ArrowUp\`). Invalid
bindings are ignored and fall back to the default.

Warn the user if they pick a binding that collides with a common OS or
app shortcut (Cmd+Q, Cmd+C/V/X/A/Z, Cmd+N).

## Other app settings

Model provider, model id, and API keys are configured in the app's
Settings screen — API keys are OS-keychain encrypted and cannot be edited
from here. If the user asks about those, point them to Settings.
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

  constructor(
    private readonly inner: CodingAgentProvider,
    private readonly sandboxProvider: SandboxProvider,
    private readonly keybindings: KeybindingsStore,
  ) {
    this.name = inner.name;
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    const session = await this.inner.startSession(opts);
    await this.stage(session);
    return session;
  }

  resumeSession(providerSessionId: string): Promise<ProviderSession> {
    return this.inner.resumeSession(providerSessionId);
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
  ): AsyncIterable<AgentEvent> {
    await this.stage(session);
    try {
      yield* this.inner.sendMessage(session, message);
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

  private async stage(session: ProviderSession): Promise<void> {
    try {
      await this.sandboxProvider.uploadFiles(
        session.sandboxId,
        {
          [DESKTOP_CONFIG_SKILL_PATH]: DESKTOP_CONFIG_SKILL,
          [DESKTOP_KEYBINDINGS_WORKSPACE_PATH]: `${JSON.stringify(
            this.keybindings.load(),
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
    try {
      const raw = await this.sandboxProvider.downloadFile(
        session.sandboxId,
        `${session.workingDirectory}/${DESKTOP_KEYBINDINGS_WORKSPACE_PATH}`,
      );
      const next = normalizeKeybindings(JSON.parse(raw));
      if (!sameBindings(next, this.keybindings.load())) {
        // save() rewrites keybindings.json; the file watcher applies it
        // live (menu rebuild + renderer broadcast).
        this.keybindings.save(next);
      }
      // Commit even when unchanged: an agent edit that normalizes to the
      // current state must still not sync back as a project draft.
      await this.commitMirrors(session, "apply desktop config");
    } catch (cause) {
      console.warn("[desktop] Failed to apply desktop config edits:", cause);
    }
  }

  private async commitMirrors(
    session: ProviderSession,
    message: string,
  ): Promise<void> {
    await this.sandboxProvider.executeCommand(
      session.sandboxId,
      `cd '${session.workingDirectory}' && ` +
        `git add '${DESKTOP_CONFIG_SKILL_PATH}' '${DESKTOP_KEYBINDINGS_WORKSPACE_PATH}' && ` +
        `(git diff --cached --quiet -- '${DESKTOP_CONFIG_SKILL_PATH}' '${DESKTOP_KEYBINDINGS_WORKSPACE_PATH}' || ` +
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
