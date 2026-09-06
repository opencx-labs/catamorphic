import { Download, RefreshCw, RotateCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type DesktopUpdateState, desktopApi } from "../lib/desktop-api.js";
import { Collapsible } from "./collapsible.js";
import { ShortcutHint } from "./shortcut-hint.js";

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
    let active = true;
    let receivedEvent = false;
    const receive = (nextState: DesktopUpdateState) => {
      if (!active) return;
      setState(nextState);
    };
    const unsubscribe = desktopApi.onUpdateStateChanged((nextState) => {
      receivedEvent = true;
      receive(nextState);
    });
    void desktopApi.updateState().then((initialState) => {
      if (!receivedEvent) receive(initialState);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const stateKey = state
    ? `${state.phase}:${state.version ?? state.currentVersion}:${state.manualCheckId ?? 0}`
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
  const open = visible && !!content && dismissed !== stateKey;
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), 200);
    return () => window.clearTimeout(timer);
  }, [open]);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  const present = open || mounted;
  useLayoutEffect(() => {
    if (
      !present ||
      !contentRef.current ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const node = contentRef.current;
    const measure = () => setHeight(node.getBoundingClientRect().height + 26);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [present]);
  if ((!open && !mounted) || !state || !content) return null;

  const progress =
    state.phase === "downloading" ? Math.round(state.percent ?? 0) : null;
  return (
    <section
      data-testid="desktop-update-banner"
      aria-live="polite"
      aria-atomic="true"
      inert={!open}
      data-state={open ? "open" : "closing"}
      style={{ height }}
      className={`fixed right-4 top-12 z-[250] w-[min(360px,calc(100vw-2rem))] origin-top-right overflow-hidden rounded-xl transition-[height] duration-200 motion-reduce:transition-none border border-border-strong bg-bg-overlay/95 p-3 text-sm text-fg shadow-2xl backdrop-blur-xl ${open ? "animate-pop-in" : "pointer-events-none animate-pop-out"}`}
    >
      <div ref={contentRef} className="flex items-start gap-3">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          <RefreshCw
            className={`col-start-1 row-start-1 size-4 transition-opacity duration-200 ${["checking", "downloading", "installing"].includes(state.phase) ? "animate-spin opacity-100" : "opacity-0"}`}
            aria-hidden="true"
          />
          <RotateCw
            className={`col-start-1 row-start-1 size-4 transition-opacity duration-200 ${state.phase === "downloaded" ? "opacity-100" : "opacity-0"}`}
            aria-hidden="true"
          />
          <Download
            className={`col-start-1 row-start-1 size-4 transition-opacity duration-200 ${["checking", "downloading", "installing", "downloaded"].includes(state.phase) ? "opacity-0" : "opacity-100"}`}
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 flex-1">
          <h2
            key={state.phase}
            className="min-h-5 animate-fade-in text-sm font-semibold text-fg"
          >
            {content.title}
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-fg-muted">
            {content.description}
          </p>
          <Collapsible open={progress !== null}>
            <div className="mt-2 flex items-center gap-2">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress ?? 100}
                aria-label="Update download progress"
                className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-inset"
              >
                <div
                  className="h-full origin-left rounded-full bg-accent transition-transform duration-200 motion-reduce:transition-none"
                  style={{ transform: `scaleX(${(progress ?? 100) / 100})` }}
                />
              </div>
              <span className="w-9 text-right text-[11px] tabular-nums text-fg-faint">
                {progress}%
              </span>
            </div>
          </Collapsible>
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
              <ShortcutHint
                label={
                  hasActiveWork
                    ? "Finish active agents and terminals before restarting"
                    : "Restart to install the update"
                }
              >
                <span tabIndex={hasActiveWork ? 0 : undefined}>
                  <button
                    type="button"
                    onClick={() => void desktopApi.updateInstall()}
                    disabled={hasActiveWork}
                    data-disabled-reason="Finish active agents and terminals before restarting"
                    className="cursor-pointer rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Restart to update
                  </button>
                </span>
              </ShortcutHint>
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
        <ShortcutHint label="Dismiss update message">
          <button
            type="button"
            onClick={() => setDismissed(stateKey)}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors duration-150 hover:bg-bg-inset hover:text-fg"
            aria-label="Dismiss update message"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </ShortcutHint>
      </div>
    </section>
  );
}

function updateContent(
  state: DesktopUpdateState | null,
  hasActiveWork: boolean,
): { title: string; description: string } | null {
  if (!state) return null;
  const channel = state.channel === "preview" ? "Preview" : "Stable";
  switch (state.phase) {
    case "checking":
      return {
        title: "Checking for updates",
        description: `You are using Catamorphic ${state.currentVersion} on the ${channel} channel.`,
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
        description:
          state.message ??
          (hasActiveWork
            ? "Finish active agents and terminals before restarting."
            : `Restart to install Catamorphic ${state.version ?? "the update"}.`),
      };
    case "installing":
      return {
        title: "Preparing to restart",
        description:
          "macOS is preparing the update. Catamorphic will restart when it is ready.",
      };
    case "up-to-date":
      return {
        title: "Catamorphic is up to date",
        description: `Version ${state.currentVersion} is the newest ${channel} update.`,
      };
    case "error":
      return {
        title: "Could not complete the update",
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
