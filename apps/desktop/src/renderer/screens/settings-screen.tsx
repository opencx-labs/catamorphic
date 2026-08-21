import {
  Check,
  Copy,
  Pencil,
  Plug,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ACTION_LABELS, KEYBINDING_ACTIONS } from "../../shared/actions.js";
import { PendingButton } from "../components/pending-button.js";
import {
  type AgentHarness,
  type AgentsData,
  type AppPrefs,
  type ConnectionInfo,
  desktopApi,
  type ImportableBrowser,
  type ThemePreset,
  type ThemeToken,
} from "../lib/desktop-api.js";
import {
  DEFAULT_KEYBINDINGS,
  formatBinding,
  type KeybindingAction,
  useKeybindings,
} from "../lib/keybindings.js";
import { useTheme } from "../lib/theme.js";

export function SettingsScreen({
  onClose,
  onAddAgent,
  onConfigureAgent,
  onManageConnectors,
}: {
  onClose: () => void;
  onAddAgent: () => void;
  /** Open the configure-agent modal (ADR 0056) for one roster agent. */
  onConfigureAgent: (agentId: string) => void;
  onManageConnectors: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-md px-6 py-4">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-base font-semibold">Settings</h1>
        <button
          type="button"
          onClick={onClose}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay hover:text-fg"
          aria-label="Close settings"
        >
          <X className="size-4" />
        </button>
      </header>

      <AgentsSection
        onAddAgent={onAddAgent}
        onConfigureAgent={onConfigureAgent}
      />
      <ConnectorsSection onManage={onManageConnectors} />
      <ThemeSection />
      <NotificationsSection />
      <ShortcutsSection />
      <ImportSection />
      <SidebarSection />
    </div>
  );
}

const HARNESS_LABELS: Record<AgentHarness, string> = {
  "ai-sdk": "Built-in",
  "claude-code": "Claude Code",
  codex: "Codex",
};

interface AgentLoginUi {
  pending?: boolean;
  command?: string;
  waiting?: boolean;
  error?: string;
}

/**
 * Per-profile roster of AI agents. New agents are added through the setup
 * wizard (opened by the host via `onAddAgent`); this section edits, signs
 * in, and removes the ones that exist.
 */
function AgentsSection({
  onAddAgent,
  onConfigureAgent,
}: {
  onAddAgent: () => void;
  onConfigureAgent: (agentId: string) => void;
}) {
  const [data, setData] = useState<AgentsData | null>(null);
  const [loginOk, setLoginOk] = useState<Record<string, boolean>>({});
  const [login, setLogin] = useState<Record<string, AgentLoginUi>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    void desktopApi.agentsList().then(setData);
    return desktopApi.onAgentsChanged(setData);
  }, []);

  // Account-auth agents report sign-in state out of band; poll it whenever
  // the roster changes.
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    const accounts = data.agents.filter((agent) => agent.auth === "account");
    void Promise.all(
      accounts.map(
        async (agent) =>
          [agent.id, await desktopApi.agentLoginStatus(agent.id)] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setLoginOk(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [data]);

  useEffect(
    () =>
      desktopApi.onAgentLoginFinished(({ agentId, ok }) => {
        setLoginOk((prev) => ({ ...prev, [agentId]: ok }));
        setLogin((prev) => ({
          ...prev,
          [agentId]: ok ? {} : { error: "Sign-in did not complete." },
        }));
      }),
    [],
  );

  const refresh = () => void desktopApi.agentsList().then(setData);

  const signIn = async (id: string) => {
    setLogin((prev) => ({ ...prev, [id]: { pending: true } }));
    try {
      const result = await desktopApi.agentLogin(id);
      setLogin((prev) => ({
        ...prev,
        [id]: result.error
          ? { error: result.error }
          : result.command
            ? { command: result.command }
            : result.started
              ? { waiting: true }
              : {},
      }));
    } catch (cause) {
      setLogin((prev) => ({
        ...prev,
        [id]: { error: cause instanceof Error ? cause.message : String(cause) },
      }));
    }
  };

  const copyCommand = (id: string, command: string) => {
    void navigator.clipboard.writeText(command);
    setCopiedId(id);
    window.setTimeout(
      () => setCopiedId((current) => (current === id ? null : current)),
      1500,
    );
  };

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Agents</h2>
        <button
          type="button"
          onClick={onAddAgent}
          data-testid="settings-add-agent"
          className="flex cursor-pointer items-center gap-1 text-xs text-fg-muted hover:text-fg"
        >
          <Plus className="size-3" />
          Add agent
        </button>
      </div>
      <p className="mb-3 text-xs text-fg-muted">
        Agents belong to the current profile. Add one with the setup wizard; set
        the default here and switch per chat from the command palette.
      </p>

      {!data ? (
        <p className="animate-pulse text-sm text-fg-muted">Loading…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {data.agents.length === 0 && (
            <p className="text-xs text-fg-faint">
              No agents yet — add one to start chatting.
            </p>
          )}

          {data.agents.map((agent) => {
            const isDefault = agent.id === data.defaultAgentId;
            const connected = loginOk[agent.id] === true;
            const ui = login[agent.id] ?? {};
            const keyed = agent.auth === "api-key";
            const authText = keyed
              ? agent.hasApiKey
                ? (agent.apiKeyMasked ?? "API key saved")
                : "No API key"
              : agent.auth === "local"
                ? "This machine's login"
                : connected
                  ? "Account connected"
                  : "Account not signed in";
            return (
              <div
                key={agent.id}
                className="group rounded-lg border border-border bg-bg-raised/40 px-3 py-2"
              >
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {agent.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => void desktopApi.agentsSetDefault(agent.id)}
                    className={`grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:text-fg ${
                      isDefault ? "" : "opacity-0 group-hover:opacity-100"
                    }`}
                    aria-label={
                      isDefault
                        ? `${agent.name} is the default agent`
                        : `Make ${agent.name} the default agent`
                    }
                    title={isDefault ? "Default agent" : "Make default"}
                  >
                    <Star
                      className={`size-3 ${isDefault ? "fill-current text-fg-muted" : ""}`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => onConfigureAgent(agent.id)}
                    className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint opacity-0 transition-colors duration-150 hover:text-fg group-hover:opacity-100"
                    aria-label={`Edit ${agent.name}`}
                    title="Edit"
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void desktopApi.agentsRemove(agent.id).then(refresh)
                    }
                    className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint opacity-0 transition-colors duration-150 hover:text-danger group-hover:opacity-100"
                    aria-label={`Remove ${agent.name}`}
                    title="Remove"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-fg-faint">
                  <span>{HARNESS_LABELS[agent.harness]}</span>
                  <span>·</span>
                  <span className={agent.model ? "font-mono" : ""}>
                    {agent.model || "default model"}
                  </span>
                  <span>·</span>
                  <span>{agent.effort} effort</span>
                  <span>·</span>
                  <span className={keyed && agent.hasApiKey ? "font-mono" : ""}>
                    {authText}
                  </span>
                </div>
                {agent.auth === "account" && !connected && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {ui.command ? (
                      <>
                        <div className="flex items-center gap-1.5">
                          <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-bg-inset px-2 py-1 font-mono text-[11px] text-fg-muted">
                            {ui.command}
                          </code>
                          <button
                            type="button"
                            onClick={() =>
                              ui.command && copyCommand(agent.id, ui.command)
                            }
                            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-muted transition-colors duration-150 hover:text-fg"
                            aria-label="Copy sign-in command"
                            title="Copy command"
                          >
                            {copiedId === agent.id ? (
                              <Check className="size-3 text-success" />
                            ) : (
                              <Copy className="size-3" />
                            )}
                          </button>
                        </div>
                        <p className="text-[11px] text-fg-faint">
                          Finish sign-in in your terminal, then come back.
                        </p>
                      </>
                    ) : (
                      <PendingButton
                        type="button"
                        pending={ui.pending === true}
                        pendingLabel="Opening…"
                        onClick={() => void signIn(agent.id)}
                        className="h-6 w-fit cursor-pointer rounded-md border border-border-strong bg-bg-inset px-2 text-[12px] text-fg-muted transition-colors duration-150 hover:border-fg-faint hover:text-fg"
                      >
                        Sign in…
                      </PendingButton>
                    )}
                    {ui.waiting && (
                      <p className="text-[11px] text-fg-faint">
                        Finish sign-in in your browser…
                      </p>
                    )}
                    {ui.error && (
                      <p className="text-[11px] text-danger">{ui.error}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Connectors live in their own manager modal (also reachable from the
 * palette: "Manage connectors…") — this section is the doorway plus a
 * quick count of what's installed.
 */
function ConnectorsSection({ onManage }: { onManage: () => void }) {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  useEffect(() => {
    void desktopApi
      .connectionsList()
      .then(setConnections)
      .catch(() => {});
    return desktopApi.onConnectionsChanged(setConnections);
  }, []);

  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="mb-1 text-sm font-semibold">Connectors</h2>
      <p className="mb-3 text-xs text-fg-muted">
        Tools your agents can use — MCP servers and Claude Code plugins.
        Installed connectors work with every agent; assign them per agent when
        editing it.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onManage}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 text-[13px] text-fg hover:bg-bg-overlay"
          data-testid="manage-connectors"
        >
          <Plug className="size-3.5" />
          Manage connectors
        </button>
        <span className="text-xs text-fg-faint">
          {connections.length === 0
            ? "None installed yet"
            : `${connections.length} connection${connections.length === 1 ? "" : "s"}`}
        </span>
      </div>
    </section>
  );
}

const TOKEN_LABELS: Record<ThemeToken, string> = {
  bg: "Background",
  "bg-raised": "Raised surface",
  "bg-overlay": "Overlay",
  "bg-inset": "Inset",
  border: "Border",
  "border-strong": "Border (strong)",
  fg: "Text",
  "fg-muted": "Text (muted)",
  "fg-faint": "Text (faint)",
  accent: "Accent",
  "accent-fg": "Text on accent",
  success: "Success",
  warning: "Warning",
  danger: "Danger",
  info: "Info",
  "user-tint": "User message tint",
  "agent-tint": "Agent message tint",
};

/**
 * Theme picker: preset swatch cards plus a per-token color editor. Changes
 * apply immediately — the main process rewrites theme.json, which
 * broadcasts the resolved theme back to every window.
 */
/**
 * Notification cues for agent activity: a soft chime when an agent
 * finishes or asks a question, and an OS notification when the window
 * isn't focused. Per profile (profiles/<id>/prefs.json), live-applied.
 */
function NotificationsSection() {
  const [prefs, setPrefsState] = useState<AppPrefs | null>(null);
  useEffect(() => {
    void desktopApi.getPrefs().then(setPrefsState);
    return desktopApi.onPrefsChanged(setPrefsState);
  }, []);
  if (!prefs) return null;

  const Toggle = ({
    label,
    description,
    checked,
    onChange,
  }: {
    label: string;
    description: string;
    checked: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-bg-raised/40 p-3">
      <span className="min-w-0">
        <span className="block text-[13px]">{label}</span>
        <span className="block text-[11px] leading-4 text-fg-faint">
          {description}
        </span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 shrink-0 accent-(--color-accent)"
      />
    </label>
  );

  return (
    <section className="mt-8 border-t border-border pt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Notifications</h2>
      </div>
      <div className="flex flex-col gap-2">
        <Toggle
          label="Notification sounds"
          description="A soft chime when an agent finishes working or asks you a question."
          checked={prefs.notificationSounds}
          onChange={(value) =>
            void desktopApi
              .setPrefs({ notificationSounds: value })
              .then(setPrefsState)
          }
        />
        <Toggle
          label="Desktop notifications"
          description="An OS notification for the same events while the app is in the background."
          checked={prefs.desktopNotifications}
          onChange={(value) =>
            void desktopApi
              .setPrefs({ desktopNotifications: value })
              .then(setPrefsState)
          }
        />
      </div>
    </section>
  );
}

function ThemeSection() {
  const theme = useTheme();
  const [presets, setPresets] = useState<ThemePreset[]>([]);
  const [file, setFile] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    void desktopApi.themePresets().then(setPresets);
    void desktopApi.themeFile().then(setFile);
  }, []);

  if (!theme) return null;

  const overridden = Object.keys(theme.overrides).length > 0;

  return (
    <section className="mt-8 border-t border-border pt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Theme</h2>
        {overridden && (
          <button
            type="button"
            onClick={() =>
              void desktopApi.setTheme({ preset: theme.preset, overrides: {} })
            }
            className="flex cursor-pointer items-center gap-1 text-xs text-fg-muted hover:text-fg"
          >
            <RotateCcw className="size-3" />
            Clear color edits
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {presets.map((preset) => {
          const active = preset.id === theme.preset;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() =>
                void desktopApi.setTheme({ preset: preset.id, overrides: {} })
              }
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors duration-150 ${
                active
                  ? "border-accent bg-accent/10"
                  : "border-border bg-bg-raised/40 hover:border-border-strong"
              }`}
            >
              <span
                className="grid size-9 shrink-0 grid-cols-2 overflow-hidden rounded-md border"
                style={{ borderColor: preset.colors.border }}
              >
                <span style={{ background: preset.colors.bg }} />
                <span style={{ background: preset.colors["bg-raised"] }} />
                <span style={{ background: preset.colors.accent }} />
                <span style={{ background: preset.colors.fg }} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px]">
                  {preset.label}
                </span>
                <span className="block text-[11px] text-fg-faint">
                  {active && overridden
                    ? "Active · edited"
                    : active
                      ? "Active"
                      : " "}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setEditing((value) => !value)}
        className="mt-3 cursor-pointer text-xs text-fg-muted hover:text-fg"
      >
        {editing ? "Hide colors" : "Edit colors…"}
      </button>

      {editing && (
        <div className="mt-2 flex flex-col gap-1">
          {(Object.keys(TOKEN_LABELS) as ThemeToken[]).map((token) => (
            <div
              key={token}
              className="flex h-8 items-center justify-between rounded-md border border-border bg-bg-raised/40 px-2.5"
            >
              <span className="text-xs">
                {TOKEN_LABELS[token]}
                {theme.overrides[token] && (
                  <span className="ml-1.5 text-accent">•</span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-fg-faint">
                  {theme.colors[token]}
                </span>
                <input
                  type="color"
                  value={toHex6(theme.colors[token])}
                  onChange={(event) =>
                    void desktopApi.setTheme({
                      preset: theme.preset,
                      overrides: {
                        ...theme.overrides,
                        [token]: event.target.value,
                      },
                    })
                  }
                  aria-label={`${TOKEN_LABELS[token]} color`}
                  className="size-5 cursor-pointer appearance-none border-none bg-transparent p-0"
                />
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="mt-2 text-xs text-fg-faint">
        Changes apply immediately. Also editable as JSON at{" "}
        <span className="font-mono">{file}</span>
      </p>
    </section>
  );
}

/** <input type=color> only accepts #rrggbb; expand #rgb, pass others as-is. */
function toHex6(color: string): string {
  const short = /^#([0-9a-f]{3})$/i.exec(color)?.[1];
  if (short) return `#${[...short].map((c) => c + c).join("")}`;
  const long = /^#([0-9a-f]{6})/i.exec(color)?.[1];
  return long ? `#${long}` : "#000000";
}

interface ImportSelection {
  checked: boolean;
  target: "current" | "new-profile";
}

/**
 * Import bookmarks (and optionally whole profiles) from other browsers on
 * this machine. Designed to grow: each detected browser lists its source
 * profiles, and every profile picks its own target.
 */
function ImportSection() {
  const [browsers, setBrowsers] = useState<ImportableBrowser[] | null>(null);
  const [selected, setSelected] = useState<Record<string, ImportSelection>>({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void desktopApi.browserImportList().then(setBrowsers);
  }, []);

  const keyOf = (browserId: string, profileId: string) =>
    `${browserId} ${profileId}`;

  const anySelected =
    browsers?.some((browser) =>
      browser.profiles.some(
        (profile) => selected[keyOf(browser.id, profile.id)]?.checked,
      ),
    ) ?? false;

  const run = async () => {
    if (!browsers) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      let bookmarks = 0;
      let profilesCreated = 0;
      for (const browser of browsers) {
        const imports = browser.profiles
          .filter((profile) => selected[keyOf(browser.id, profile.id)]?.checked)
          .map((profile) => ({
            sourceProfileId: profile.id,
            sourceProfileName: profile.name,
            target:
              selected[keyOf(browser.id, profile.id)]?.target ?? "current",
          }));
        if (imports.length === 0) continue;
        const outcome = await desktopApi.browserImportRun({
          browserId: browser.id,
          imports,
        });
        bookmarks += outcome.bookmarksImported;
        profilesCreated += outcome.profilesCreated.length;
      }
      setResult(
        `Imported ${bookmarks} bookmark${bookmarks === 1 ? "" : "s"}${
          profilesCreated > 0
            ? ` and created ${profilesCreated} profile${profilesCreated === 1 ? "" : "s"}`
            : ""
        }.`,
      );
      setSelected({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="mb-1 text-sm font-semibold">Import from browser</h2>
      <p className="mb-3 text-xs text-fg-muted">
        Bring bookmarks over from another browser on this Mac.
      </p>

      {!browsers ? (
        <p className="animate-pulse text-sm text-fg-muted">
          Looking for browsers…
        </p>
      ) : browsers.length === 0 ? (
        <p className="text-xs text-fg-faint">No other browsers detected.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {browsers.map((browser) => (
            <div key={browser.id}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                {browser.label}
              </p>
              <div className="flex flex-col gap-1.5">
                {browser.profiles.map((profile) => {
                  const key = keyOf(browser.id, profile.id);
                  const sel = selected[key] ?? {
                    checked: false,
                    target: "current" as const,
                  };
                  return (
                    <div
                      key={profile.id}
                      className="flex h-9 items-center gap-2.5 rounded-lg border border-border bg-bg-raised/40 px-3"
                    >
                      <input
                        type="checkbox"
                        checked={sel.checked}
                        onChange={(event) =>
                          setSelected((prev) => ({
                            ...prev,
                            [key]: { ...sel, checked: event.target.checked },
                          }))
                        }
                        aria-label={`Import ${profile.name} from ${browser.label}`}
                        className="size-3.5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {profile.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-fg-faint">
                        {profile.bookmarkCount} bookmark
                        {profile.bookmarkCount === 1 ? "" : "s"}
                      </span>
                      <select
                        value={sel.target}
                        onChange={(event) =>
                          setSelected((prev) => ({
                            ...prev,
                            [key]: {
                              ...sel,
                              target: event.target.value as
                                | "current"
                                | "new-profile",
                            },
                          }))
                        }
                        disabled={!sel.checked}
                        aria-label={`Import target for ${profile.name}`}
                        className="field h-6 shrink-0 px-1 text-[11px] text-fg disabled:opacity-50"
                      >
                        <option value="current">Into current profile</option>
                        <option value="new-profile">As new profile</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {error && <p className="text-xs text-danger">{error}</p>}
          {result && !error && <p className="text-xs text-success">{result}</p>}

          <PendingButton
            type="button"
            pending={importing}
            pendingLabel="Importing…"
            disabled={!anySelected}
            onClick={() => void run()}
            className="h-8 w-fit cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            Import
          </PendingButton>
        </div>
      )}

      <p className="mt-2 text-xs text-fg-faint">
        Only bookmarks are imported — they land as pinned bookmarks; folders are
        flattened.
      </p>
    </section>
  );
}

/**
 * The sidebar is defined by a JS file, not a settings form — this section
 * points at it and offers a way back from a bad edit.
 */
function SidebarSection() {
  const [file, setFile] = useState("");
  useEffect(() => {
    void desktopApi.sidebarConfigFile().then(setFile);
  }, []);

  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="mb-1 text-sm font-semibold">Sidebar</h2>
      <p className="text-xs text-fg-muted">
        The left sidebar's sections and items are defined in a JavaScript file.
        Edit it directly, or ask the assistant to change it for you (&ldquo;hide
        the workflows section&rdquo;, &ldquo;add a Docs section&rdquo;). Changes
        apply live.
      </p>
      <p className="mt-2 text-xs text-fg-faint">
        <span className="font-mono">{file}</span>
      </p>
      <button
        type="button"
        onClick={() => void desktopApi.sidebarConfigReset()}
        className="mt-3 flex cursor-pointer items-center gap-1 text-xs text-fg-muted hover:text-fg"
      >
        <RotateCcw className="size-3" />
        Reset sidebar to default
      </button>
    </section>
  );
}

/**
 * Keyboard shortcuts editor. Each row captures the next keypress while
 * recording. Saves apply immediately (no Save button) — the main process
 * rewrites keybindings.json, which broadcasts back to every window.
 */
function ShortcutsSection() {
  const bindings = useKeybindings();
  const [recording, setRecording] = useState<KeybindingAction | null>(null);
  const [file, setFile] = useState<string>("");

  useEffect(() => {
    void desktopApi.keybindingsFile().then(setFile);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      // Wait for a real key, not a bare modifier press.
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
      const parts = [
        ...(event.metaKey ? ["Cmd"] : []),
        ...(event.ctrlKey ? ["Ctrl"] : []),
        ...(event.altKey ? ["Alt"] : []),
        ...(event.shiftKey ? ["Shift"] : []),
        event.key.length === 1 ? event.key.toUpperCase() : event.key,
      ];
      void desktopApi.setKeybindings({
        ...bindings,
        [recording]: parts.join("+"),
      });
      setRecording(null);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording, bindings]);

  const isDefault = (Object.keys(bindings) as KeybindingAction[]).every(
    (action) => bindings[action] === DEFAULT_KEYBINDINGS[action],
  );

  return (
    <section className="mt-8 border-t border-border pt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
        {!isDefault && (
          <button
            type="button"
            onClick={() => void desktopApi.setKeybindings(DEFAULT_KEYBINDINGS)}
            className="flex cursor-pointer items-center gap-1 text-xs text-fg-muted hover:text-fg"
          >
            <RotateCcw className="size-3" />
            Reset to defaults
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {KEYBINDING_ACTIONS.map((action) => (
          <div
            key={action}
            className="flex h-9 items-center justify-between rounded-lg border border-border bg-bg-raised/40 px-3"
          >
            <span className="text-[13px]">{ACTION_LABELS[action]}</span>
            <button
              type="button"
              onClick={() => setRecording(recording === action ? null : action)}
              className={`h-6 cursor-pointer rounded-md border px-2 font-sans text-[12px] transition-colors duration-150 ${
                recording === action
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border-strong bg-bg-inset text-fg-muted hover:border-fg-faint hover:text-fg"
              }`}
            >
              {recording === action
                ? "Press keys…"
                : formatBinding(bindings[action])}
            </button>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-fg-faint">
        Changes apply immediately, in every project. Also editable as JSON at{" "}
        <span className="font-mono">{file}</span>
      </p>
    </section>
  );
}
