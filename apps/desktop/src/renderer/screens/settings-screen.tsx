import {
  Check,
  Copy,
  Monitor,
  Pencil,
  Plug,
  Plus,
  RotateCcw,
  Search,
  Star,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACTION_LABELS, KEYBINDING_ACTIONS } from "../../shared/actions.js";
import { bindingFromEvent, parseBinding } from "../../shared/keybindings.js";
import type { TerminalMacro } from "../../shared/terminal-macros.js";
import {
  DEFAULT_THEME_FONTS,
  isValidFontStack,
} from "../../shared/theme-fonts.js";
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
  matchesBinding,
  useKeybindings,
} from "../lib/keybindings.js";
import { useTerminalAppearance } from "../lib/terminal-appearance.js";
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
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("agents");
  const scrollRef = useRef<HTMLDivElement>(null);
  const sections = [
    {
      id: "agents",
      label: "Agents",
      keywords: "models authentication accounts sign in",
      content: (
        <AgentsSection
          onAddAgent={onAddAgent}
          onConfigureAgent={onConfigureAgent}
        />
      ),
    },
    {
      id: "connections",
      label: "Connections",
      keywords: "connectors plugins mcp tools",
      content: <ConnectorsSection onManage={onManageConnectors} />,
    },
    {
      id: "appearance",
      label: "Appearance",
      keywords:
        "theme colors dark light nord catppuccin rose pine font ghostty terminal",
      content: (
        <>
          <ThemeSection />
          <TerminalSection />
        </>
      ),
    },
    {
      id: "workspace",
      label: "Workspace",
      keywords:
        "layout sidebar tabs header address bookmarks links preview floating",
      content: (
        <>
          <LayoutSection />
          <SidebarSection />
        </>
      ),
    },
    {
      id: "macros",
      label: "Macros",
      keywords: "terminal shell command custom launcher shortcut",
      content: <MacrosSection />,
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      keywords: "keys bindings hotkeys",
      content: <ShortcutsSection />,
    },
    {
      id: "notifications",
      label: "Notifications",
      keywords: "sound chime desktop alerts",
      content: <NotificationsSection />,
    },
    {
      id: "import",
      label: "Import",
      keywords: "browser aside chrome arc bookmarks passwords history",
      content: <ImportSection />,
    },
  ];
  const words = query.toLowerCase().trim().split(/\s+/);
  const visible = sections.filter((section) =>
    words.every((word) =>
      `${section.label} ${section.keywords}`.toLowerCase().includes(word),
    ),
  );
  const navigateTo = (id: string) => {
    setQuery("");
    setSelected(id);
    requestAnimationFrame(() =>
      scrollRef.current
        ?.querySelector(`#settings-${id}`)
        ?.scrollIntoView({ block: "start" }),
    );
  };
  return (
    <div
      className="@container/settings flex min-h-0 min-w-0 flex-1 flex-col"
      data-settings
      data-testid="settings-screen"
    >
      <header className="mx-auto flex w-full max-w-5xl shrink-0 flex-wrap items-center gap-3 px-6 pt-5 pb-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">Settings</h1>
          <p className="mt-1 text-xs text-fg-muted">
            Make this profile your own.
          </p>
        </div>
        <label className="relative order-3 w-full @xl/settings:order-none @xl/settings:w-64">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-fg-muted" />
          <input
            aria-label="Search settings"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              scrollRef.current?.scrollTo({ top: 0 });
            }}
            placeholder="Search settings…"
            className="field h-8 w-full rounded-lg pr-3 pl-8 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={onClose}
          className="grid size-8 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay hover:text-fg"
          aria-label="Close settings"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col @2xl/settings:flex-row">
        <label className="flex shrink-0 items-center gap-3 px-6 pb-4 text-sm text-fg-muted @2xl/settings:hidden">
          Category
          <select
            aria-label="Settings category"
            value={selected}
            onChange={(event) => navigateTo(event.target.value)}
            className="field h-8 min-w-0 flex-1 rounded-lg px-2 text-fg"
          >
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.label}
              </option>
            ))}
          </select>
        </label>
        <nav
          aria-label="Settings categories"
          className="hidden w-48 shrink-0 flex-col gap-1 overflow-y-auto px-6 pr-3 pb-3 @2xl/settings:flex"
        >
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              aria-current={
                !query && selected === section.id ? "location" : undefined
              }
              onClick={() => navigateTo(section.id)}
              className={`shrink-0 cursor-pointer whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150 ${!query && selected === section.id ? "bg-bg-overlay font-medium text-fg" : "text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"}`}
            >
              {section.label}
            </button>
          ))}
        </nav>
        <div
          ref={scrollRef}
          data-settings-scroll
          onScroll={() => {
            const root = scrollRef.current;
            if (!root || query) return;
            const top = root.getBoundingClientRect().top;
            const current = [...sections].reverse().find((section) => {
              const element = root.querySelector(`#settings-${section.id}`);
              return element && element.getBoundingClientRect().top <= top + 24;
            });
            if (current) setSelected(current.id);
          }}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-10"
        >
          {visible.length === 0 && (
            <p role="status" className="py-8 text-sm text-fg-muted">
              No settings match “{query}”. Try a category such as appearance,
              macros or shortcuts.
            </p>
          )}
          {sections.map((section) => (
            <div
              key={section.id}
              id={`settings-${section.id}`}
              hidden={!visible.includes(section)}
              className="settings-category mb-8 max-w-2xl scroll-mt-2"
            >
              {section.content}
            </div>
          ))}
        </div>
      </div>
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
    <section className="mt-8">
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
  sidebar: "Sidebar and window frame",
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
    <section className="mt-8">
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

function TerminalSection() {
  const { appearance, source, loading, error, reload } =
    useTerminalAppearance();
  return (
    <section className="mt-8 flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Terminal</h2>
      <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
        Appearance
        <select
          name="terminalAppearance"
          value={source}
          onChange={(event) =>
            void desktopApi.setPrefs({
              terminalAppearance:
                event.target.value === "ghostty" ? "ghostty" : "app",
            })
          }
          className="field h-8 rounded-md px-2 text-sm"
        >
          <option value="app">App theme</option>
          <option value="ghostty">Ghostty configuration</option>
        </select>
      </label>
      {source === "ghostty" && (
        <>
          <p className="text-xs text-fg-muted" aria-live="polite">
            {loading
              ? "Reading Ghostty configuration…"
              : `${appearance.name} · ${appearance.fontSize} · ${appearance.fontFamily.replaceAll('"', "")}`}
          </p>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error} Keeping {appearance.name}.
            </p>
          )}
          <button
            type="button"
            onClick={reload}
            disabled={loading}
            className="btn self-start rounded-md px-3 py-1.5 text-xs disabled:opacity-50"
          >
            Reload from Ghostty
          </button>
          <p className="text-xs text-fg-muted">
            Reads your colors and fonts when the app opens. Reload after editing
            Ghostty's configuration. Native window effects and Ghostty shortcuts
            stay in Ghostty.
          </p>
        </>
      )}
      <p className="text-xs text-fg-muted">
        Appearance changes apply to new terminals. Terminals use your login
        shell and its startup files. Your prompt, aliases and shell tools keep
        their existing configuration.
      </p>
    </section>
  );
}

function LayoutSection() {
  const [prefs, setPrefs] = useState<AppPrefs | null>(null);
  useEffect(() => {
    void desktopApi.getPrefs().then(setPrefs);
    return desktopApi.onPrefsChanged(setPrefs);
  }, []);
  if (!prefs) return null;
  return (
    <section className="mt-8 flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Workspace layout</h2>
      <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
        Open tabs
        <select
          name="tabPlacement"
          value={prefs.tabPlacement}
          onChange={(event) =>
            void desktopApi.setPrefs({
              tabPlacement:
                event.target.value === "sidebar" ? "sidebar" : "top",
            })
          }
          className="field h-8 rounded-md px-2 text-sm"
        >
          <option value="top">Top bar</option>
          <option value="sidebar">Sidebar</option>
        </select>
      </label>
      {prefs.tabPlacement === "sidebar" && (
        <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
          Title and address bar
          <select
            name="headerPlacement"
            value={prefs.headerPlacement}
            onChange={(event) =>
              void desktopApi.setPrefs({
                headerPlacement:
                  event.target.value === "sidebar" ? "sidebar" : "top",
              })
            }
            className="field h-8 rounded-md px-2 text-sm"
          >
            <option value="top">Above content</option>
            <option value="sidebar">In sidebar</option>
          </select>
        </label>
      )}
      <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
        Pinned bookmarks
        <select
          name="pinnedBookmarks"
          value={prefs.pinnedBookmarks}
          onChange={(event) =>
            void desktopApi.setPrefs({
              pinnedBookmarks: event.target.value === "list" ? "list" : "tiles",
            })
          }
          className="field h-8 rounded-md px-2 text-sm"
        >
          <option value="tiles">Icon tiles</option>
          <option value="list">List</option>
        </select>
      </label>
      <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
        Links requesting a new window
        <select
          name="linkOpenMode"
          value={prefs.linkOpenMode}
          onChange={(event) =>
            void desktopApi.setPrefs({
              linkOpenMode:
                event.target.value === "floating" ? "floating" : "tab",
            })
          }
          className="field h-8 rounded-md px-2 text-sm"
        >
          <option value="tab">New tab</option>
          <option value="floating">Floating preview</option>
        </select>
      </label>
      <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
        {/Mac/.test(navigator.platform) ? "Option" : "Alt"}-click links to
        preview
        <input
          type="checkbox"
          name="previewLinksWithAlt"
          checked={prefs.previewLinksWithAlt}
          onChange={(event) =>
            void desktopApi.setPrefs({
              previewLinksWithAlt: event.target.checked,
            })
          }
        />
      </label>
      <p className="text-sm text-fg-muted text-pretty">
        Changes apply to this profile. You can also ask your agent to arrange
        the sidebar or change these preferences.
      </p>
    </section>
  );
}

function MacrosSection() {
  const [prefs, setPrefs] = useState<AppPrefs | null>(null);
  const [draft, setDraft] = useState<TerminalMacro | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const bindings = useKeybindings();
  useEffect(() => {
    void desktopApi.getPrefs().then(setPrefs);
    return desktopApi.onPrefsChanged(setPrefs);
  }, []);
  const macros = prefs?.terminalMacros ?? [];
  useEffect(() => {
    if (!recording || !draft) return;
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
      const shortcut = bindingFromEvent(event);
      const parsed = shortcut ? parseBinding(shortcut) : null;
      if (!parsed || (!parsed.modifiers.size && !/^F\d+$/.test(parsed.key))) {
        setError("Include a modifier key, such as Command, Control or Option.");
        return;
      }
      const conflict = KEYBINDING_ACTIONS.find((action) =>
        matchesBinding(event, bindings[action]),
      );
      const otherMacro = macros.find(
        (macro) =>
          macro.id !== draft.id && matchesBinding(event, macro.shortcut),
      );
      if (conflict || otherMacro) {
        setError(
          `Already used by ${conflict ? ACTION_LABELS[conflict] : otherMacro?.name}. Choose another shortcut.`,
        );
        return;
      }
      setDraft({ ...draft, shortcut: shortcut ?? "" });
      setError("");
      setRecording(false);
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [recording, draft, macros, bindings]);
  const save = async (next: TerminalMacro[]) => {
    setSaving(true);
    setError("");
    try {
      setPrefs(await desktopApi.setPrefs({ terminalMacros: next }));
      setDraft(null);
      setRecording(false);
    } catch {
      setError("Could not save your macros. Please try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="mt-8 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Terminal macros</h2>
        <button
          type="button"
          disabled={!prefs || saving}
          onClick={() => {
            setDraft({
              id: crypto.randomUUID(),
              name: "",
              command: "",
              shortcut: "",
            });
            setError("");
            setRecording(false);
          }}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm hover:bg-bg-overlay disabled:cursor-default disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          Add macro
        </button>
      </div>
      <p className="text-sm text-fg-muted text-pretty">
        Save commands you use often. Run a macro from the command palette, or
        assign a shortcut to toggle its floating terminal.
      </p>
      {!macros.length && !draft && (
        <div className="flex items-start gap-3 rounded-xl bg-bg-inset/60 p-4">
          <TerminalSquare className="mt-0.5 size-5 shrink-0 text-fg-muted" />
          <div>
            <p className="text-sm font-medium">Your commands, your choice</p>
            <p className="mt-1 text-sm text-fg-muted">
              No macros are installed by default. Add a shell tool, a dev server
              or any command you want.
            </p>
          </div>
        </div>
      )}
      {macros.map((macro) => (
        <div
          key={macro.id}
          className="flex min-w-0 items-center gap-2 rounded-lg bg-bg-raised px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{macro.name}</p>
            <p className="truncate font-mono text-xs text-fg-muted">
              {macro.command}
            </p>
          </div>
          {macro.shortcut && (
            <kbd className="shrink-0 text-xs text-fg-muted">
              {formatBinding(macro.shortcut)}
            </kbd>
          )}
          <button
            type="button"
            aria-label={`Edit macro ${macro.name}`}
            disabled={saving}
            onClick={() => {
              setDraft(macro);
              setError("");
              setRecording(false);
            }}
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Delete macro ${macro.name}`}
            disabled={saving}
            onClick={() =>
              void save(macros.filter((item) => item.id !== macro.id))
            }
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      {draft && (
        <form
          data-macro-editor
          className="flex min-w-0 flex-col gap-3 rounded-xl bg-bg-inset/60 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.name.trim() || !draft.command.trim()) return;
            void save([
              ...macros.filter((macro) => macro.id !== draft.id),
              draft,
            ]);
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm">
            Name
            <input
              name="macroName"
              required
              value={draft.name}
              onChange={(event) =>
                setDraft(
                  (current) =>
                    current && { ...current, name: event.target.value },
                )
              }
              placeholder="My terminal tool"
              className="field h-8 rounded-md px-2"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            Command
            <textarea
              name="macroCommand"
              required
              rows={3}
              value={draft.command}
              onChange={(event) =>
                setDraft(
                  (current) =>
                    current && { ...current, command: event.target.value },
                )
              }
              placeholder="Enter a shell command"
              className="field min-h-20 resize-y rounded-md px-2 py-2 font-mono text-sm"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="mr-auto">Shortcut</span>
            <button
              type="button"
              aria-label="Record macro shortcut"
              aria-pressed={recording}
              onBlur={() => setRecording(false)}
              onClick={() => setRecording(!recording)}
              className="field h-8 cursor-pointer rounded-md px-3"
            >
              {recording
                ? "Press keys…"
                : formatBinding(draft.shortcut) || "Record shortcut"}
            </button>
            {draft.shortcut && (
              <button
                type="button"
                onClick={() => setDraft({ ...draft, shortcut: "" })}
                className="text-xs text-fg-muted hover:text-fg"
              >
                Clear
              </button>
            )}
          </div>
          <p className="text-xs text-fg-muted">
            Runs in the current project folder using your shell setup. Saving
            does not run the command. Reopening a running macro keeps the same
            terminal.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setRecording(false);
                setError("");
              }}
              className="h-8 cursor-pointer rounded-md px-3 text-sm hover:bg-bg-overlay disabled:cursor-default disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                saving ||
                recording ||
                !draft.name.trim() ||
                !draft.command.trim()
              }
              className="h-8 cursor-pointer rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:cursor-default disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save macro"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <p className="text-xs text-fg-muted">
        Macros belong to this profile. Removing a macro leaves its open
        terminals running.
      </p>
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
  const dark = presets.find((preset) => preset.id === "dark");
  const light = presets.find((preset) => preset.id === "light");
  const systemSelected = theme.selection === "system";

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Theme</h2>
        {overridden && (
          <button
            type="button"
            onClick={() =>
              void desktopApi.setTheme({
                fonts: theme.fonts,
                selection: theme.selection,
                overrides: {},
              })
            }
            className="flex cursor-pointer items-center gap-1 text-xs text-fg-muted hover:text-fg"
          >
            <RotateCcw className="size-3" />
            Clear color edits
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() =>
          void desktopApi.setTheme({
            selection: "system",
            overrides: {},
            fonts: theme.fonts,
          })
        }
        aria-pressed={systemSelected}
        className={`mb-2 flex w-full cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors duration-150 ${
          systemSelected
            ? "border-accent bg-accent/10"
            : "border-border bg-bg-raised/40 hover:border-border-strong"
        }`}
      >
        <span className="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-md border border-border">
          <span
            className="absolute inset-y-0 left-0 w-1/2"
            style={{ background: dark?.colors.bg }}
          />
          <span
            className="absolute inset-y-0 right-0 w-1/2"
            style={{ background: light?.colors.bg }}
          />
          <Monitor className="relative size-4 text-fg" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px]">System default</span>
          <span className="block text-[11px] text-fg-faint">
            {systemSelected
              ? `Following your device · ${theme.appearance === "dark" ? "Dark" : "Light"}`
              : "Uses Catamorphic Light or Dark automatically"}
          </span>
        </span>
      </button>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
        {presets.map((preset) => {
          const active = preset.id === theme.selection;
          return (
            <button
              key={preset.id}
              type="button"
              aria-label={preset.label}
              aria-pressed={active}
              data-theme-preset={preset.id}
              onClick={() =>
                void desktopApi.setTheme({
                  fonts: theme.fonts,
                  selection: preset.id,
                  overrides: {},
                })
              }
              className={`flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border p-2.5 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                active
                  ? "border-accent bg-accent/10"
                  : "border-border bg-bg-raised/40 hover:border-border-strong"
              }`}
            >
              <span
                aria-hidden="true"
                className="flex h-16 w-full gap-1.5 overflow-hidden rounded-md border p-1.5"
                style={{
                  background: preset.colors.sidebar,
                  borderColor: preset.colors.border,
                }}
              >
                <span className="flex w-1/4 flex-col gap-1 pt-1">
                  <span
                    className="h-1 w-3 rounded-sm"
                    style={{ background: preset.colors["fg-muted"] }}
                  />
                  <span
                    className="mt-1 h-2 rounded-sm"
                    style={{ background: preset.colors.accent }}
                  />
                  <span
                    className="h-1 w-3/4 rounded-sm"
                    style={{ background: preset.colors["fg-muted"] }}
                  />
                </span>
                <span
                  className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-sm p-2"
                  style={{ background: preset.colors.bg }}
                >
                  <span
                    className="h-1 w-2/3 rounded-sm"
                    style={{ background: preset.colors.fg }}
                  />
                  <span
                    className="h-1 w-full rounded-sm"
                    style={{ background: preset.colors["fg-muted"] }}
                  />
                  <span
                    className="mt-auto h-2.5 w-1/3 rounded-sm"
                    style={{ background: preset.colors.accent }}
                  />
                </span>
              </span>
              <span className="w-full min-w-0">
                <span className="block text-[13px]">{preset.label}</span>
                <span className="block min-h-4 text-[11px] text-fg-muted">
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
                      fonts: theme.fonts,
                      selection: theme.selection,
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

      <div className="mt-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium">Fonts</h3>
          {(theme.fonts.sans !== DEFAULT_THEME_FONTS.sans ||
            theme.fonts.mono !== DEFAULT_THEME_FONTS.mono) && (
            <button
              type="button"
              className="cursor-pointer text-xs text-fg-muted hover:text-fg"
              onClick={() =>
                void desktopApi.setTheme({
                  selection: theme.selection,
                  overrides: theme.overrides,
                })
              }
            >
              Reset fonts
            </button>
          )}
        </div>
        {(["sans", "mono"] as const).map((token) => (
          <label
            key={token}
            className="flex flex-col gap-1 text-xs text-fg-muted"
          >
            {token === "sans" ? "Interface font" : "Monospace font"}
            <input
              key={theme.fonts[token]}
              type="text"
              defaultValue={theme.fonts[token]}
              placeholder={DEFAULT_THEME_FONTS[token]}
              spellCheck={false}
              maxLength={200}
              className="field h-8 w-full px-2 text-xs text-fg"
              onChange={(event) => event.currentTarget.setCustomValidity("")}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              onBlur={(event) => {
                const value = event.currentTarget.value.trim();
                if (value && !isValidFontStack(value)) {
                  event.currentTarget.setCustomValidity(
                    "Enter font names separated by commas, such as Arial, sans-serif.",
                  );
                  event.currentTarget.reportValidity();
                  return;
                }
                const font = value || DEFAULT_THEME_FONTS[token];
                event.currentTarget.value = font;
                if (font === theme.fonts[token]) return;
                void desktopApi.setTheme({
                  selection: theme.selection,
                  overrides: theme.overrides,
                  fonts: { ...theme.fonts, [token]: font },
                });
              }}
            />
          </label>
        ))}
        <p className="text-xs text-fg-faint">
          Use installed font names with comma-separated fallbacks. Press Enter
          or leave the field to apply. Clear a field to restore its default.
        </p>
      </div>

      <p className="mt-2 text-xs text-fg-faint">
        Changes apply immediately. Also editable as JSON at{" "}
        <span className="break-all font-mono">{file}</span>
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
    `${browserId}\0${profileId}`;

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
    <section className="mt-8">
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
                      className="flex min-h-9 flex-wrap items-center gap-2.5 rounded-lg border border-border bg-bg-raised/40 px-3 py-2"
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
            data-disabled-reason="Select bookmarks to import"
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
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-semibold">Sidebar</h2>
      <p className="text-xs text-fg-muted">
        The left sidebar's sections and items are defined in a JavaScript file.
        Edit it directly, or ask the assistant to change it for you (&ldquo;hide
        the workflows section&rdquo;, &ldquo;add a Docs section&rdquo;). Changes
        apply live.
      </p>
      <p className="mt-2 text-xs text-fg-faint">
        <span className="break-all font-mono">{file}</span>
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
  const [prefs, setPrefs] = useState<AppPrefs | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    void desktopApi.getPrefs().then(setPrefs);
    return desktopApi.onPrefsChanged(setPrefs);
  }, []);
  const bindings = useKeybindings();
  const [recording, setRecording] = useState<KeybindingAction | null>(null);
  const [file, setFile] = useState<string>("");
  const [notice, setNotice] = useState("");

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
      const binding = bindingFromEvent(event);
      if (!binding) {
        setNotice("That key cannot be used as a shortcut. Try another key.");
        return;
      }
      const macroConflict = prefs?.terminalMacros.find((macro) =>
        matchesBinding(event, macro.shortcut),
      );
      if (macroConflict) {
        setNotice(
          `Already used by macro ${macroConflict.name}. Choose another shortcut.`,
        );
        return;
      }
      const conflicts = KEYBINDING_ACTIONS.filter(
        (action) =>
          action !== recording && matchesBinding(event, bindings[action]),
      );
      const next = { ...bindings, [recording]: binding };
      for (const action of conflicts) next[action] = "";
      void desktopApi.setKeybindings(next);
      setNotice(
        conflicts.length
          ? `Shortcut moved from ${conflicts.map((action) => ACTION_LABELS[action]).join(", ")} to ${ACTION_LABELS[recording]}.`
          : `Shortcut updated for ${ACTION_LABELS[recording]}.`,
      );
      setRecording(null);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording, bindings, prefs]);

  const isDefault = (Object.keys(bindings) as KeybindingAction[]).every(
    (action) => bindings[action] === DEFAULT_KEYBINDINGS[action],
  );

  return (
    <section className="mt-8">
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
      <input
        aria-label="Search keyboard shortcuts"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Find a shortcut…"
        className="field mb-3 h-8 w-full rounded-md px-3 text-sm"
      />
      <div className="flex flex-col gap-1.5">
        {KEYBINDING_ACTIONS.filter((action) =>
          `${ACTION_LABELS[action]} ${bindings[action]}`
            .toLowerCase()
            .includes(filter.toLowerCase()),
        ).map((action) => (
          <div
            key={action}
            className="flex min-h-9 flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-raised/40 px-3 py-1.5"
          >
            <span className="text-[13px]">{ACTION_LABELS[action]}</span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label={`Change shortcut for ${ACTION_LABELS[action]}`}
                onBlur={() => setRecording(null)}
                onClick={() =>
                  setRecording(recording === action ? null : action)
                }
                className={`h-6 cursor-pointer rounded-md border px-2 font-sans text-[12px] transition-colors duration-150 ${
                  recording === action
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border-strong bg-bg-inset text-fg-muted hover:border-fg-faint hover:text-fg"
                }`}
              >
                {recording === action
                  ? "Press keys…"
                  : formatBinding(bindings[action]) || "Unassigned"}
              </button>
              {bindings[action] && (
                <button
                  type="button"
                  aria-label={`Remove shortcut for ${ACTION_LABELS[action]}`}
                  onClick={() => {
                    void desktopApi.setKeybindings({
                      ...bindings,
                      [action]: "",
                    });
                    setNotice(`Shortcut removed for ${ACTION_LABELS[action]}.`);
                  }}
                  className="grid size-6 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay hover:text-fg"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <p role="status" className="mt-2 text-xs text-fg-muted">
        {notice}
      </p>
      <p className="mt-2 text-xs text-fg-faint">
        Changes apply immediately, in every project. Also editable as JSON at{" "}
        <span className="break-all font-mono">{file}</span>
      </p>
    </section>
  );
}
