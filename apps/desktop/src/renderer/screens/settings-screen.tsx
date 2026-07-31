import { X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { PendingButton } from "../components/pending-button.js";
import {
  desktopApi,
  type PublicSettings,
  type UpdateSettingsInput,
} from "../lib/desktop-api.js";

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
    </div>
  );
}
