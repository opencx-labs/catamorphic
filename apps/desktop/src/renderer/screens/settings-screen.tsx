import { RotateCcw, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { PendingButton } from "../components/pending-button.js";
import {
  desktopApi,
  type PublicSettings,
  type UpdateSettingsInput,
} from "../lib/desktop-api.js";
import {
  DEFAULT_KEYBINDINGS,
  formatBinding,
  type KeybindingAction,
  useKeybindings,
} from "../lib/keybindings.js";

const SUGGESTED_MODELS: Record<"anthropic" | "openai", string[]> = {
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-5"],
  openai: ["gpt-5.6-luna", "gpt-5.1", "gpt-5"],
};

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [provider, setProvider] = useState<"anthropic" | "openai">("anthropic");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void desktopApi.getSettings().then((loaded) => {
      setSettings(loaded);
      setProvider(loaded.provider);
      setModel(loaded.model);
    });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const input: UpdateSettingsInput = { provider, model };
      if (apiKey.trim()) input.apiKey = apiKey.trim();
      const next = await desktopApi.setSettings(input);
      setSettings(next);
      setApiKey("");
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

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

      {!settings ? (
        <p className="animate-pulse text-sm text-fg-muted">Loading…</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Provider
            <select
              value={provider}
              onChange={(event) => {
                const next = event.target.value as "anthropic" | "openai";
                setProvider(next);
                setModel(SUGGESTED_MODELS[next][0] ?? "");
              }}
              className="field h-8 px-2 text-[13px] text-fg"
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Model
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              list="model-suggestions"
              className="field h-8 px-2 font-mono text-[13px] text-fg"
              spellCheck={false}
            />
            <datalist id="model-suggestions">
              {SUGGESTED_MODELS[provider].map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <span className="text-fg-faint">
              Any model id your API key can access.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            API key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                settings.hasApiKey
                  ? `Saved (${settings.apiKeyMasked}) — enter to replace`
                  : provider === "anthropic"
                    ? "sk-ant-…"
                    : "sk-…"
              }
              className="field h-8 px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
              autoComplete="off"
            />
            <span className="text-fg-faint">
              Stored encrypted with your OS keychain. Applying settings restarts
              the local server.
            </span>
          </label>

          {error && <p className="text-xs text-danger">{error}</p>}
          {saved && !error && (
            <p className="text-xs text-success">Saved — server restarted.</p>
          )}

          <PendingButton
            type="submit"
            pending={saving}
            pendingLabel="Applying…"
            disabled={!settings.hasApiKey && !apiKey.trim()}
            className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </PendingButton>
        </form>
      )}

      <ShortcutsSection />
      <SidebarSection />
    </div>
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
        The left sidebar's sections and items are defined in a JavaScript
        file. Edit it directly, or ask the assistant to change it for you
        (&ldquo;hide the workflows section&rdquo;, &ldquo;add a Docs
        section&rdquo;). Changes apply live.
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

const SHORTCUT_LABELS: Record<KeybindingAction, string> = {
  "new-chat": "New chat tab",
  "new-floating-chat": "New floating chat",
  "new-browser-tab": "New browser tab",
  "toggle-sidebar": "Toggle sidebar",
  "close-tab": "Close tab",
};

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
        {(Object.keys(SHORTCUT_LABELS) as KeybindingAction[]).map((action) => (
          <div
            key={action}
            className="flex h-9 items-center justify-between rounded-lg border border-border bg-bg-raised/40 px-3"
          >
            <span className="text-[13px]">{SHORTCUT_LABELS[action]}</span>
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
