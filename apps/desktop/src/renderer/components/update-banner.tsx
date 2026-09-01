import { Download, RefreshCw, RotateCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type DesktopUpdateState, desktopApi } from "../lib/desktop-api.js";

export function UpdateBanner({
  hasActiveWork,
  onOpenRelease,
}: {
  hasActiveWork: boolean;
  onOpenRelease: (url: string) => void;
}) {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const receive = (nextState: DesktopUpdateState) => {
      setDismissed(null);
      setState(nextState);
    };
    void desktopApi.updateState().then(receive);
    return desktopApi.onUpdateStateChanged(receive);
  }, []);

  const stateKey = state
    ? `${state.phase}:${state.version ?? state.currentVersion}`
    : "loading";

  const visible =
    state !== null &&
    (state.manual ||
      state.phase === "available" ||
      state.phase === "downloading" ||
      state.phase === "downloaded");
  const content = useMemo(
    () => updateContent(state, hasActiveWork),
    [state, hasActiveWork],
  );
  if (!visible || !content || dismissed === stateKey) return null;

  const progress =
    state.phase === "downloading" ? Math.round(state.percent ?? 0) : null;
  return (
    <section
      data-testid="desktop-update-banner"
      aria-live="polite"
      aria-atomic="true"
      className="fixed right-4 top-12 z-[250] w-[min(360px,calc(100vw-2rem))] animate-pop-in rounded-xl border border-border-strong bg-bg-overlay/95 p-3 text-sm text-fg shadow-2xl backdrop-blur-xl"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          {state.phase === "checking" || state.phase === "downloading" ? (
            <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
          ) : state.phase === "downloaded" ? (
            <RotateCw className="size-4" aria-hidden="true" />
          ) : (
            <Download className="size-4" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-fg">{content.title}</h2>
          <p className="mt-0.5 text-xs leading-5 text-fg-muted">
            {content.description}
          </p>
          {progress !== null && (
            <div className="mt-2 flex items-center gap-2">
              <progress
                className="h-1.5 min-w-0 flex-1 accent-accent"
                value={progress}
                max={100}
                aria-label="Update download progress"
              />
              <span className="w-9 text-right text-[11px] tabular-nums text-fg-faint">
                {progress}%
              </span>
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {state.phase === "available" && (
              <button
                type="button"
                onClick={() => void desktopApi.updateDownload()}
                className="cursor-pointer rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
              >
                Download update
              </button>
            )}
            {state.phase === "downloaded" && (
              <button
                type="button"
                onClick={() => void desktopApi.updateInstall()}
                disabled={hasActiveWork}
                className="cursor-pointer rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Restart to update
              </button>
            )}
            {(state.phase === "error" || state.phase === "up-to-date") && (
              <button
                type="button"
                onClick={() => void desktopApi.updateCheck()}
                className="cursor-pointer rounded-md bg-bg-raised px-2.5 py-1.5 text-xs font-medium text-fg transition-colors duration-150 hover:bg-bg-inset"
              >
                Check again
              </button>
            )}
            {state.releaseUrl && (
              <button
                type="button"
                onClick={() => onOpenRelease(state.releaseUrl ?? "")}
                className="cursor-pointer px-1 py-1.5 text-xs font-medium text-accent hover:underline"
              >
                Release notes
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(stateKey)}
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors duration-150 hover:bg-bg-inset hover:text-fg"
          aria-label="Dismiss update message"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function updateContent(
  state: DesktopUpdateState | null,
  hasActiveWork: boolean,
): { title: string; description: string } | null {
  if (!state) return null;
  switch (state.phase) {
    case "checking":
      return {
        title: "Checking for updates",
        description: `You are using Catamorphic ${state.currentVersion}.`,
      };
    case "available":
      return {
        title: `Catamorphic ${state.version ?? "update"} is available`,
        description: "Download it now and restart whenever your work is ready.",
      };
    case "downloading":
      return {
        title: `Downloading Catamorphic ${state.version ?? "update"}`,
        description: "You can keep working while the update downloads.",
      };
    case "downloaded":
      return {
        title: "Update ready",
        description: hasActiveWork
          ? "Finish active agents and terminals before restarting."
          : `Restart to install Catamorphic ${state.version ?? "the update"}.`,
      };
    case "up-to-date":
      return {
        title: "Catamorphic is up to date",
        description: `Version ${state.currentVersion} is the newest available update.`,
      };
    case "error":
      return {
        title: "Could not check for updates",
        description: state.message ?? "Try again when you are back online.",
      };
    case "unsupported":
      return {
        title: "Updates are unavailable here",
        description:
          state.message ?? "Install Catamorphic to receive desktop updates.",
      };
    case "idle":
      return null;
  }
}
