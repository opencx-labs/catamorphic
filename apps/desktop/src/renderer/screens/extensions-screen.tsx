import { ChevronRight, Pin, Puzzle, RotateCw, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import {
  CHROME_WEB_STORE_URL,
  chromeWebStoreDetailUrl,
  type ExtensionSummary,
} from "../../shared/extensions.js";
import { Collapsible } from "../components/collapsible.js";
import { PendingButton } from "../components/pending-button.js";
import { ShortcutHint } from "../components/shortcut-hint.js";
import { desktopApi } from "../lib/desktop-api.js";
import { useExtensionsState } from "../lib/extensions.js";
import { formatBinding } from "../lib/keybindings.js";
import { useListMotion } from "../lib/list-motion.js";
import { useWorkspace } from "../lib/workspace-context.js";

/**
 * The profile's extensions (ADR 0203), Chrome's chrome://extensions in
 * Work's page shape: one card per extension with its switch, what it can
 * do, its shortcuts and actions. Developer mode adds loading a folder and
 * checking the store for updates now.
 */
export function ExtensionsScreen({
  active = true,
  onOpenUrl,
}: {
  active?: boolean;
  onOpenUrl: (url: string) => void;
}) {
  const runtime = useWorkspace();
  const { state, error, refresh } = useExtensionsState(
    runtime.visible && active,
  );
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const extensions = state?.extensions ?? [];
  useListMotion(list, extensions.map(({ id }) => id).join("\n"));
  const developerId = useId();

  const loadUnpacked = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const loaded = await desktopApi.extensionsLoadUnpacked();
      if (loaded) setNotice(`Loaded ${loaded.name}.`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
      void refresh();
    }
  };
  const updateNow = async () => {
    setUpdating(true);
    setNotice(null);
    try {
      await desktopApi.extensionsUpdateNow();
      setNotice("Extensions are up to date.");
    } catch (cause) {
      setNotice(
        `Could not check for updates: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="extensions-page">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <Puzzle className="size-4 text-fg-muted" />
        <h1 className="min-w-0 flex-1 text-sm font-medium text-fg">
          Extensions
        </h1>
        <label
          htmlFor={developerId}
          className="flex cursor-pointer items-center gap-2 text-xs text-fg-muted"
        >
          Developer mode
          <input
            id={developerId}
            type="checkbox"
            role="switch"
            aria-checked={state?.developerMode ?? false}
            checked={state?.developerMode ?? false}
            disabled={!state}
            data-testid="extensions-developer-mode"
            onChange={(event) =>
              void desktopApi
                .extensionsDeveloperMode({ enabled: event.target.checked })
                .then(refresh)
            }
          />
        </label>
        <button
          type="button"
          className="button-secondary button-sm"
          onClick={() => onOpenUrl(CHROME_WEB_STORE_URL)}
          data-testid="extensions-open-store"
        >
          Chrome Web Store
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-8">
        <div ref={list} className="mx-auto flex max-w-3xl flex-col gap-4 pt-6">
          {state && !state.sandboxed && (
            <section
              className="settings-card"
              data-testid="extensions-unsandboxed"
            >
              <h2 className="text-[13px] font-semibold text-fg">
                Extensions are limited
              </h2>
              <p className="mt-1 text-xs leading-5 text-fg-muted">
                Work was started with Chromium’s sandbox turned off, so an
                extension’s background worker cannot use the browser features
                Work provides. Start Work without the --no-sandbox flag.
              </p>
            </section>
          )}
          {state?.developerMode && (
            <section
              className="settings-card"
              data-testid="extensions-developer"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[13px] font-semibold text-fg">
                  Developer mode
                </h2>
                {state.checking && (
                  <span className="text-xs text-fg-faint">
                    Checking for updates…
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-5 text-fg-muted">
                Load an extension from its folder to work on it, or check the
                Chrome Web Store for updates now.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <PendingButton
                  pending={loading}
                  className="button-primary"
                  onClick={() => void loadUnpacked()}
                  data-testid="extensions-load-unpacked"
                >
                  Load unpacked
                </PendingButton>
                <PendingButton
                  pending={updating || (state.checking ?? false)}
                  className="button-secondary"
                  onClick={() => void updateNow()}
                >
                  Update
                </PendingButton>
              </div>
              <p
                role="status"
                className="mt-2 min-h-4 text-xs text-fg-muted"
                data-testid="extensions-notice"
              >
                {notice}
              </p>
            </section>
          )}
          {extensions.map((extension) => (
            <ExtensionCard
              key={extension.id}
              extension={extension}
              developerMode={state?.developerMode ?? false}
              onOpenUrl={onOpenUrl}
            />
          ))}
          {state && extensions.length === 0 && (
            <div className="py-16 text-center">
              <p className="text-[13px] text-fg-faint">
                Extensions you add from the Chrome Web Store appear here.
              </p>
              <button
                type="button"
                className="button-primary mt-4"
                onClick={() => onOpenUrl(CHROME_WEB_STORE_URL)}
              >
                Browse the Chrome Web Store
              </button>
            </div>
          )}
          {!state && (
            <p className="py-16 text-center text-[13px] text-fg-muted">
              {error ?? ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ExtensionCard({
  extension,
  developerMode,
  onOpenUrl,
}: {
  extension: ExtensionSummary;
  developerMode: boolean;
  onOpenUrl: (url: string) => void;
}) {
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  // The switch moves at once; a failure moves it back with the reason.
  const [turning, setTurning] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const status = failure
    ? failure
    : extension.pendingUpdate
      ? "An update needs your approval."
      : extension.error
        ? extension.error
        : !extension.enabled
          ? extension.disabledReason === "permissions"
            ? "Turned off until you accept its new access."
            : "Turned off."
          : null;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="settings-card"
      data-testid="extension-card"
      data-extension-id={extension.id}
      data-enabled={extension.enabled}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-bg-inset">
          {extension.iconUrl ? (
            <img
              src={extension.iconUrl}
              alt=""
              className="size-7 object-contain"
            />
          ) : (
            <Puzzle className="size-5 text-fg-muted" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2
              className="truncate text-[13px] font-semibold text-fg"
              data-testid="extension-card-name"
            >
              {extension.name}
            </h2>
            <span className="shrink-0 font-mono text-[11px] text-fg-faint">
              {extension.version}
            </span>
            {extension.source === "unpacked" && (
              <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-fg-muted">
                Unpacked
              </span>
            )}
          </div>
          {extension.description && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-fg-muted">
              {extension.description}
            </p>
          )}
          {status && (
            <p
              className={`mt-1 text-xs ${extension.error ? "text-danger" : "text-fg-muted"}`}
              data-testid="extension-card-status"
            >
              {status}
            </p>
          )}
        </div>
        {/* Pin, remove, and on or off: the card's own actions, as in Chrome. */}
        <div className="flex shrink-0 items-center gap-1">
          {extension.enabled && extension.hasAction && (
            <ShortcutHint
              label={extension.pinned ? "Unpin from toolbar" : "Pin to toolbar"}
            >
              <button
                type="button"
                aria-label={
                  extension.pinned
                    ? `Unpin ${extension.name} from the toolbar`
                    : `Pin ${extension.name} to the toolbar`
                }
                aria-pressed={extension.pinned}
                data-testid="extension-card-pin"
                data-pinned={extension.pinned}
                onClick={() =>
                  void desktopApi.extensionsSetPinned({
                    id: extension.id,
                    pinned: !extension.pinned,
                  })
                }
                className={`grid size-7 cursor-pointer place-items-center rounded-md transition-colors duration-150 hover:bg-bg-overlay ${
                  extension.pinned
                    ? "text-accent"
                    : "text-fg-muted hover:text-fg"
                }`}
              >
                <Pin
                  className={`size-3.5 transition-[fill] duration-150 ${extension.pinned ? "fill-current" : ""}`}
                />
              </button>
            </ShortcutHint>
          )}
          <ShortcutHint label="Remove">
            <button
              type="button"
              aria-label={`Remove ${extension.name}`}
              data-testid="extension-card-remove"
              onClick={() =>
                void desktopApi.extensionsRemove({ id: extension.id })
              }
              className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-danger"
            >
              <Trash2 className="size-3.5" />
            </button>
          </ShortcutHint>
          <input
            type="checkbox"
            role="switch"
            className="ml-1.5"
            aria-checked={turning ?? extension.enabled}
            checked={turning ?? extension.enabled}
            disabled={Boolean(extension.pendingUpdate)}
            data-testid="extension-card-enabled"
            aria-label={extension.name}
            onChange={(event) => {
              const enabled = event.target.checked;
              setTurning(enabled);
              setFailure(null);
              void desktopApi
                .extensionsSetEnabled({ id: extension.id, enabled })
                .catch((error: unknown) =>
                  setFailure(
                    error instanceof Error
                      ? error.message
                      : "It could not be changed.",
                  ),
                )
                .finally(() => setTurning(null));
            }}
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {extension.pendingUpdate && (
          <button
            type="button"
            className="button-primary button-sm"
            onClick={() =>
              void desktopApi.extensionsReviewUpdate({ id: extension.id })
            }
          >
            Review update
          </button>
        )}
        {extension.enabled && extension.hasOptions && (
          <button
            type="button"
            className="button-secondary button-sm"
            onClick={() =>
              void desktopApi.extensionsOpenOptions({ id: extension.id })
            }
          >
            Options
          </button>
        )}
        {extension.source === "unpacked" && extension.enabled && (
          <ShortcutHint label="Reload">
            <button
              type="button"
              aria-label={`Reload ${extension.name}`}
              className="button-secondary button-sm"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  desktopApi.extensionsReload({ id: extension.id }),
                )
              }
            >
              <RotateCw className="size-3.5" />
            </button>
          </ShortcutHint>
        )}
        <span className="flex-1" />
        <button
          type="button"
          className="button-ghost button-sm"
          aria-expanded={details}
          onClick={() => setDetails((open) => !open)}
          data-testid="extension-card-details"
        >
          Details
          <ChevronRight
            className={`size-3.5 transition-transform duration-150 ${details ? "rotate-90" : ""}`}
          />
        </button>
      </div>
      <Collapsible open={details}>
        <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 border-t border-border pt-3 text-xs leading-5">
          <dt className="text-fg-muted">It can</dt>
          <dd className="text-fg">
            {extension.warnings.length > 0 ? (
              <ul className="space-y-0.5">
                {extension.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : (
              "Nothing that needs your permission"
            )}
          </dd>
          {extension.commands.length > 0 && (
            <>
              <dt className="text-fg-muted">Shortcuts</dt>
              <dd className="text-fg">
                <ul className="space-y-0.5">
                  {extension.commands.map((command) => (
                    <li key={command.name} className="flex gap-3">
                      <span className="min-w-0 flex-1 truncate">
                        {command.description}
                      </span>
                      <span className="shrink-0 font-mono text-fg-muted">
                        {command.shortcut
                          ? formatBinding(command.shortcut)
                          : "Not set"}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          <dt className="text-fg-muted">ID</dt>
          <dd className="select-text font-mono text-fg">{extension.id}</dd>
          <dt className="text-fg-muted">Source</dt>
          <dd className="min-w-0 text-fg">
            {extension.source === "webstore" ? (
              <button
                type="button"
                className="text-left text-fg underline decoration-border underline-offset-2 hover:decoration-fg-muted"
                onClick={() => onOpenUrl(chromeWebStoreDetailUrl(extension.id))}
              >
                Chrome Web Store
              </button>
            ) : (
              <span className="block truncate font-mono">
                {developerMode ? extension.path : "A folder on this computer"}
              </span>
            )}
          </dd>
        </dl>
      </Collapsible>
    </section>
  );
}
