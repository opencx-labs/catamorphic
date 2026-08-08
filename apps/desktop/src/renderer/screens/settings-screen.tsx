import {
  Check,
  Copy,
  Pencil,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useState,
} from "react";
import { ACTION_LABELS, KEYBINDING_ACTIONS } from "../../shared/actions.js";
import { PendingButton } from "../components/pending-button.js";
import {
  type AgentAuthMode,
  type AgentEffort,
  type AgentHarness,
  type AgentInfo,
  type AgentsData,
  type AppPrefs,
  desktopApi,
  type ImportableBrowser,
  type OpenRouterCatalog,
  type ThemePreset,
  type ThemeToken,
  type UpdateAgentInput,
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
}: {
  onClose: () => void;
  onAddAgent: () => void;
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

      <AgentsSection onAddAgent={onAddAgent} />
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

const MODEL_PLACEHOLDERS: Record<AgentHarness, string> = {
  "ai-sdk": "claude-sonnet-4-5",
  "claude-code": "claude-sonnet-4-5",
  codex: "gpt-5.3-codex",
};

type AiSdkProvider = "anthropic" | "openai" | "openrouter";

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
function AgentsSection({ onAddAgent }: { onAddAgent: () => void }) {
  const [data, setData] = useState<AgentsData | null>(null);
  const [loginOk, setLoginOk] = useState<Record<string, boolean>>({});
  const [login, setLogin] = useState<Record<string, AgentLoginUi>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

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
            if (editingId === agent.id) {
              return (
                <AgentForm
                  key={agent.id}
                  agent={agent}
                  onDone={() => {
                    setEditingId(null);
                    refresh();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              );
            }
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
                    onClick={() => setEditingId(agent.id)}
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
 * Edit form for one existing agent (new agents come from the setup wizard).
 * The API key field is keep-by-default: empty input leaves the stored key
 * alone, "Clear saved key" removes it explicitly.
 */
function AgentForm({
  agent,
  onDone,
  onCancel,
}: {
  agent: AgentInfo;
  onDone: () => void;
  onCancel: () => void;
}) {
  const harness = agent.harness;
  const [name, setName] = useState(agent.name);
  const [provider, setProvider] = useState<AiSdkProvider>(
    agent.provider ?? "anthropic",
  );
  const [model, setModel] = useState(agent.model);
  const [effort, setEffort] = useState<AgentEffort>(agent.effort);
  const [auth, setAuth] = useState<AgentAuthMode>(agent.auth);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Anthropic/OpenAI are key-only; OpenRouter can also sign in with an
  // account, and the CLI harnesses add "this machine's login" on top.
  const effectiveAuth: AgentAuthMode =
    harness === "ai-sdk" && provider !== "openrouter"
      ? "api-key"
      : harness === "ai-sdk" && auth === "local"
        ? "account"
        : auth;
  const hasSavedKey = agent.hasApiKey && !clearKey;
  const keyPlaceholder = hasSavedKey
    ? `Saved (${agent.apiKeyMasked}) — leave empty to keep`
    : harness === "codex" || (harness === "ai-sdk" && provider === "openai")
      ? "sk-…"
      : harness === "ai-sdk" && provider === "openrouter"
        ? "sk-or-…"
        : "sk-ant-…";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const patch: UpdateAgentInput = {
        name: name.trim() || undefined,
        model: model.trim(),
        effort,
        auth: effectiveAuth,
      };
      if (harness === "ai-sdk") patch.provider = provider;
      if (clearKey) patch.apiKey = null;
      else if (apiKey.trim()) patch.apiKey = apiKey.trim();
      await desktopApi.agentsUpdate(agent.id, patch);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border border-border bg-bg-raised/40 p-3"
    >
      <span className="text-xs font-semibold">
        {`Edit ${HARNESS_LABELS[harness]} agent`}
      </span>

      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={HARNESS_LABELS[harness]}
          className="field h-8 px-2 text-[13px] text-fg placeholder:text-fg-faint"
          spellCheck={false}
        />
      </label>

      {harness === "ai-sdk" && (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Provider
          <select
            value={provider}
            onChange={(event) => {
              const next = event.target.value as AiSdkProvider;
              setProvider(next);
              setAuth(next === "openrouter" ? "account" : "api-key");
            }}
            className="field h-8 px-2 text-[13px] text-fg"
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </label>
      )}

      {harness === "ai-sdk" && provider === "openrouter" ? (
        <OpenRouterModelField value={model} onChange={setModel} />
      ) : (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Model
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={MODEL_PLACEHOLDERS[harness]}
            className="field h-8 px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
            spellCheck={false}
          />
          <span className="text-fg-faint">
            {harness === "ai-sdk"
              ? "Any model id your API key can access."
              : "Leave empty to use the harness default."}
          </span>
        </label>
      )}

      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Effort
        <select
          value={effort}
          onChange={(event) => setEffort(event.target.value as AgentEffort)}
          className="field h-8 px-2 text-[13px] text-fg"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>

      {(harness !== "ai-sdk" || provider === "openrouter") && (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Authentication
          <select
            value={effectiveAuth}
            onChange={(event) => setAuth(event.target.value as AgentAuthMode)}
            className="field h-8 px-2 text-[13px] text-fg"
          >
            {harness !== "ai-sdk" && (
              <option value="local">This machine's login</option>
            )}
            <option value="account">
              {harness === "ai-sdk"
                ? "Account (sign in — no key needed)"
                : "Separate account"}
            </option>
            <option value="api-key">API key</option>
          </select>
        </label>
      )}

      {effectiveAuth === "api-key" && (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              if (event.target.value) setClearKey(false);
            }}
            placeholder={keyPlaceholder}
            className="field h-8 px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
            autoComplete="off"
          />
          <span className="flex items-center justify-between gap-2 text-fg-faint">
            {clearKey
              ? "Saved key will be removed."
              : "Stored encrypted with your OS keychain."}
            {agent.hasApiKey && (
              <button
                type="button"
                onClick={() => setClearKey((value) => !value)}
                className="shrink-0 cursor-pointer text-fg-muted hover:text-fg"
              >
                {clearKey ? "Keep saved key" : "Clear saved key"}
              </button>
            )}
          </span>
        </label>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <PendingButton
          type="submit"
          pending={saving}
          pendingLabel="Saving…"
          disabled={
            effectiveAuth === "api-key" && !hasSavedKey && !apiKey.trim()
          }
          className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </PendingButton>
        <button
          type="button"
          onClick={onCancel}
          className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

interface OpenRouterRow {
  key: string;
  /** "" selects the synthetic best-free entry (resolved dynamically). */
  modelId: string;
  title: string;
  detail: string;
  free: boolean;
}

/**
 * Searchable model picker for OpenRouter agents. The mono input is both the
 * stored value and the search box; a dropdown below it filters the catalog
 * while focused. An empty model means "current best free model", surfaced
 * as the synthetic first row. If the catalog can't load, degrades to the
 * plain text input.
 */
function OpenRouterModelField({
  value,
  onChange,
}: {
  value: string;
  onChange: (model: string) => void;
}) {
  const [catalog, setCatalog] = useState<OpenRouterCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    desktopApi
      .openrouterModels()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const query = value.trim().toLowerCase();
  const bestId = catalog?.bestFreeModelId ?? null;
  const showBest =
    query === "" ||
    "best free model (automatic)".includes(query) ||
    (bestId?.toLowerCase().includes(query) ?? false);
  const rows: OpenRouterRow[] = catalog
    ? [
        ...(showBest
          ? [
              {
                key: " best",
                modelId: "",
                title: "Best free model (automatic)",
                detail: bestId ?? "no free models right now",
                free: false,
              },
            ]
          : []),
        ...catalog.models
          .filter(
            (m) =>
              m.id.toLowerCase().includes(query) ||
              m.name.toLowerCase().includes(query),
          )
          .sort(
            (a, b) => Number(b.free) - Number(a.free) || b.created - a.created,
          )
          .slice(0, 50)
          .map((m) => ({
            key: m.id,
            modelId: m.id,
            title: m.name,
            detail: m.id,
            free: m.free,
          })),
      ]
    : [];
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));

  const select = (modelId: string) => {
    onChange(modelId);
    setOpen(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive(Math.min(Math.max(activeIndex + delta, 0), rows.length - 1));
      return;
    }
    if (event.key === "Enter" && open && rows.length > 0) {
      event.preventDefault();
      const row = rows[activeIndex];
      if (row) select(row.modelId);
    }
  };

  if (failed) {
    return (
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Model
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Best free model (automatic)"
          className="field h-8 px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
          spellCheck={false}
        />
        <span className="text-fg-faint">Couldn't load the model list.</span>
      </label>
    );
  }

  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      Model
      <div className="relative">
        <input
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder={`Best free model (${bestId ?? "automatic"})`}
          aria-label="Model"
          className="field h-8 w-full px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
          spellCheck={false}
          autoComplete="off"
        />
        {open && (
          <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-bg-overlay py-1">
            {!catalog ? (
              <p className="animate-pulse px-2.5 py-1.5 text-[13px] text-fg-muted">
                Loading models…
              </p>
            ) : rows.length === 0 ? (
              <p className="px-2.5 py-1.5 text-[13px] text-fg-faint">
                No models match — the typed id is used as-is.
              </p>
            ) : (
              rows.map((row, index) => (
                <button
                  key={row.key}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    select(row.modelId);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={`flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150 ${
                    index === activeIndex ? "bg-bg-inset" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-fg">
                      {row.title}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-fg-faint">
                      {row.detail}
                    </span>
                  </span>
                  {row.free && (
                    <span className="shrink-0 rounded border border-border-strong px-1 text-[10px] text-fg-muted">
                      free
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <span className="text-fg-faint">
        Leave empty to always use the current best free model.
      </span>
    </div>
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
