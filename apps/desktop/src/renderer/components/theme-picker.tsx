import { ChevronDown, Monitor, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { SettingsScope } from "../../shared/settings.js";
import type { SettingsDestination } from "../../shared/settings-catalog.js";
import {
  DEFAULT_THEME_FONTS,
  isValidFontStack,
} from "../../shared/theme-fonts.js";
import { TOKEN_LABELS } from "../../shared/theme-tokens.js";
import {
  desktopApi,
  type ThemePreset,
  type ThemeToken,
} from "../lib/desktop-api.js";
import { Collapsible } from "./collapsible.js";
import { Modal } from "./modal.js";

export function ThemePicker({
  open,
  projectId,
  destination,
  onClose,
  onCustomize,
}: {
  open: boolean;
  projectId?: string;
  destination?: SettingsDestination;
  onClose: () => void;
  onCustomize: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      labelledBy="theme-picker-title"
      animateSize
    >
      <header className="px-6 pt-6 pb-4">
        <h2
          id="theme-picker-title"
          className="text-xl font-semibold tracking-tight"
        >
          Make yourself at home
        </h2>
        <p className="mt-1 text-[13px] text-fg-muted">
          Choose a theme. See it everywhere.
        </p>
      </header>
      <div className="px-6 pb-5">
        <ThemeEditor
          key={projectId ?? "profile"}
          projectId={projectId}
          destination={destination}
        />
      </div>
      <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg-raised px-6 py-4">
        <button
          type="button"
          onClick={onCustomize}
          className="theme-agent-link"
        >
          <Sparkles className="size-3.5 shrink-0" />
          <span>
            Have a theme in mind?{" "}
            <span className="text-fg">Make it with an agent</span>
          </span>
        </button>
        <button
          type="button"
          className="button-primary min-w-20"
          onClick={onClose}
        >
          Done
        </button>
      </footer>
    </Modal>
  );
}

function ThemeEditor({
  projectId,
  destination,
}: {
  projectId?: string;
  destination?: SettingsDestination;
}) {
  const [scope, setScope] = useState<SettingsScope>(
    projectId ? "personal" : "profile",
  );
  const [theme, setTheme] = useState<Awaited<
    ReturnType<typeof desktopApi.getTheme>
  > | null>(null);
  const [config, setConfig] = useState<
    Awaited<ReturnType<typeof desktopApi.themeConfig>>
  >({});
  const [projectAvailable, setProjectAvailable] = useState(false);
  const [presets, setPresets] = useState<ThemePreset[]>([]);
  const [file, setFile] = useState("");
  const [saveError, setSaveError] = useState("");
  const editorRef = useRef<HTMLElement>(null);
  const revealedDestination = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const [reload, setReload] = useState(0);
  const saveTheme = (next: Parameters<typeof desktopApi.setTheme>[0]) => {
    const request = ++generation.current;
    void desktopApi
      .setTheme(next, projectId, scope)
      .then(async (resolved) => {
        const authored = await desktopApi.themeConfig(projectId, scope);
        if (request !== generation.current) return;
        setTheme(resolved);
        setConfig(authored);
        setSaveError("");
      })
      .catch((error) => {
        if (request === generation.current) setSaveError(String(error));
      });
  };
  useEffect(() => {
    void reload; // An explicit retry starts a new scoped read.
    const refresh = () => {
      const request = ++generation.current;
      void Promise.all([
        desktopApi.getTheme(projectId, scope),
        desktopApi.themeConfig(projectId, scope),
        desktopApi.themeFile(projectId, scope),
        desktopApi.getSettings({ projectId, scope }),
        desktopApi.themePresets(),
      ])
        .then(([resolved, authored, file, settings, presets]) => {
          if (request !== generation.current) return;
          setTheme(resolved);
          setConfig(authored);
          setFile(file);
          setProjectAvailable(settings.projectAvailable);
          setPresets(presets);
          setSaveError(settings.errors.join("\n"));
        })
        .catch((error) => {
          if (request === generation.current) setSaveError(String(error));
        });
    };
    setTheme(null);
    refresh();
    const stop = desktopApi.onThemeChanged(refresh);
    return () => {
      generation.current++;
      stop();
    };
  }, [projectId, scope, reload]);
  const [editing, setEditing] = useState(false);
  const disclosureId = useId();
  useEffect(() => {
    if (destination && destination.id !== "theme.selection") setEditing(true);
  }, [destination]);

  useEffect(() => {
    if (
      !theme ||
      !destination ||
      revealedDestination.current === destination.requestId
    )
      return;
    const frame = requestAnimationFrame(() => {
      const root = editorRef.current;
      const target =
        destination.id === "theme.selection"
          ? root
          : root?.querySelector<HTMLElement>(
              `[data-setting-id="${destination.id}"]`,
            );
      if (!target) return;
      revealedDestination.current = destination.requestId;
      target.dataset.settingsTarget = "true";
      target.scrollIntoView({ block: "center", behavior: "instant" });
      target
        .querySelector<HTMLElement>("input, button, select")
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [theme, destination]);

  if (!theme)
    return (
      <div className="grid min-h-60 place-content-center text-center text-sm text-fg-muted">
        {saveError ? (
          <>
            <p role="alert" className="max-w-sm break-words text-danger">
              {saveError}
            </p>
            <button
              type="button"
              className="button-secondary mt-4"
              onClick={() => setReload((value) => value + 1)}
            >
              Try again
            </button>
          </>
        ) : (
          <p role="status">Loading themes…</p>
        )}
      </div>
    );

  const overridden = Object.keys(config.overrides ?? {}).length > 0;
  const dark = presets.find((preset) => preset.id === "dark");
  const light = presets.find((preset) => preset.id === "light");
  const systemSelected = theme.selection === "system";

  return (
    <section
      ref={editorRef}
      className="theme-editor"
      data-setting-id="theme.selection"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-fg-muted">Changes apply immediately</span>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          Apply to
          <select
            aria-label="Theme scope"
            className="field h-8 rounded-md px-2"
            value={scope}
            onChange={(event) => {
              const value = event.target.value;
              if (
                value === "profile" ||
                value === "project" ||
                value === "personal"
              )
                setScope(value);
            }}
          >
            <option value="profile">Profile</option>
            {projectId && projectAvailable && (
              <option value="project">Project</option>
            )}
            {projectId && <option value="personal">Just for me</option>}
          </select>
        </label>
        {scope !== "profile" && (
          <button
            type="button"
            className="text-xs text-fg-muted hover:text-fg"
            onClick={() => saveTheme(null)}
          >
            Use inherited theme
          </button>
        )}
      </div>
      {scope !== "profile" && (
        <p className="mb-3 text-xs text-fg-muted">
          Only changes in this scope override the inherited theme.
        </p>
      )}
      {saveError && (
        <p role="alert" className="mb-3 break-words text-xs text-danger">
          {saveError}
        </p>
      )}
      {overridden && (
        <button
          type="button"
          onClick={() =>
            void saveTheme({
              fonts: config.fonts,
              ...(config.selection ? { selection: config.selection } : {}),
              overrides: {},
            })
          }
          className="mb-3 flex cursor-pointer items-center gap-1 text-xs text-fg-muted hover:text-fg"
        >
          <RotateCcw className="size-3" />
          Clear color edits
        </button>
      )}

      <button
        type="button"
        onClick={() =>
          void saveTheme({
            selection: "system",
            overrides: {},
            fonts: config.fonts,
          })
        }
        data-setting-control
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
              : "Uses Work Light or Dark automatically"}
          </span>
        </span>
      </button>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
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
                void saveTheme({
                  fonts: config.fonts,
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
                className="flex h-12 w-full gap-1.5 overflow-hidden rounded-md border p-1.5"
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
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        id={disclosureId}
        aria-expanded={editing}
        aria-controls={`${disclosureId}-content`}
        onClick={() => setEditing((value) => !value)}
        className="mt-4 flex w-full cursor-pointer items-center justify-between gap-3 border-t border-border pt-4 pb-1 text-left text-[13px] text-fg-muted hover:text-fg"
      >
        Customize colors and fonts
        <ChevronDown
          className={`size-3.5 transition-transform duration-200 motion-reduce:transition-none ${editing ? "rotate-180" : ""}`}
        />
      </button>

      <section id={`${disclosureId}-content`} aria-labelledby={disclosureId}>
        <Collapsible open={editing}>
          <div className="mt-2 flex flex-col gap-1">
            {(Object.keys(TOKEN_LABELS) as ThemeToken[]).map((token) => (
              <div
                key={token}
                data-setting-id={`theme.overrides.${token}`}
                className="flex h-8 items-center justify-between rounded-md border border-border bg-bg-raised/40 px-2.5"
              >
                <span className="text-xs">
                  {TOKEN_LABELS[token]}
                  {config.overrides?.[token] && (
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
                      void saveTheme({
                        fonts: config.fonts,
                        ...(config.selection
                          ? { selection: config.selection }
                          : {}),
                        overrides: {
                          ...config.overrides,
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

          <div className="mt-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium">Fonts</h3>
              {(theme.fonts.sans !== DEFAULT_THEME_FONTS.sans ||
                theme.fonts.mono !== DEFAULT_THEME_FONTS.mono) && (
                <button
                  type="button"
                  className="cursor-pointer text-xs text-fg-muted hover:text-fg"
                  onClick={() =>
                    void saveTheme({
                      ...(config.selection
                        ? { selection: config.selection }
                        : {}),
                      overrides: config.overrides,
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
                data-setting-id={`theme.fonts.${token}`}
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
                  onChange={(event) =>
                    event.currentTarget.setCustomValidity("")
                  }
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
                    void saveTheme({
                      ...(config.selection
                        ? { selection: config.selection }
                        : {}),
                      overrides: config.overrides,
                      fonts: { ...config.fonts, [token]: font },
                    });
                  }}
                />
              </label>
            ))}
            <p className="text-xs text-fg-faint">
              Use installed font names with comma-separated fallbacks. Press
              Enter or leave the field to apply. Clear a field to restore its
              default.
            </p>
          </div>
          <p className="mt-3 break-all font-mono text-[11px] text-fg-faint">
            {file}
          </p>
        </Collapsible>
      </section>
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
