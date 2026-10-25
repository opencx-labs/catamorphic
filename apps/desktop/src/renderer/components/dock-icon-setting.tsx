import { useCallback, useEffect, useRef, useState } from "react";
import workIcon from "../../../build/icon.png";
import {
  type DockIconState,
  MAX_DOCK_ICON_BYTES,
} from "../../shared/dock-icon.js";
import { desktopApi } from "../lib/desktop-api.js";
import { PendingButton } from "./pending-button.js";

export function DockIconSetting() {
  const [state, setState] = useState<DockIconState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const apply = useCallback(
    (next: DockIconState) =>
      setState((current) =>
        !current || next.revision >= current.revision ? next : current,
      ),
    [],
  );

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = desktopApi.onDockIconChanged((next) => {
      apply(next);
      setError(undefined);
    });
    void desktopApi
      .dockIconState()
      .then((next) => {
        if (mounted.current) apply(next);
      })
      .catch(() => {
        if (mounted.current)
          setError(
            "Could not load your Dock icon. Reopen Settings to try again.",
          );
      });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [apply]);

  const change = async (file?: File) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      if (file && file.size > MAX_DOCK_ICON_BYTES)
        throw new Error("Choose a PNG or JPEG image up to 10 MB.");
      const next = file
        ? await desktopApi.dockIconSet(new Uint8Array(await file.arrayBuffer()))
        : await desktopApi.dockIconReset();
      if (mounted.current) apply(next);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not change your Dock icon. Try again.",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return (
    <section className="settings-card mt-4" data-setting-id="dockIcon">
      <h2 className="text-sm font-semibold text-fg">Dock icon</h2>
      <p className="mt-1 text-xs leading-5 text-fg-muted">
        Use your own image while Work runs. Applies to every profile on this
        Mac.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <img
          src={state?.preview ?? workIcon}
          alt={
            state?.custom && state.preview
              ? "Custom Dock icon"
              : "Work Dock icon"
          }
          className="size-12 shrink-0 object-contain"
        />
        <PendingButton
          pending={pending}
          disabled={state?.supported === false}
          data-setting-control
          className="button-secondary"
          onClick={() => input.current?.click()}
        >
          Choose image…
        </PendingButton>
        <button
          type="button"
          className="button-ghost"
          disabled={pending || !state?.custom}
          data-disabled-reason={
            !state?.custom ? "Using the Work icon" : undefined
          }
          onClick={() => void change()}
        >
          Reset
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg"
          aria-label="Dock icon image"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void change(file);
          }}
        />
      </div>
      <p className="mt-2 text-xs leading-5 text-fg-muted">
        PNG or JPEG, up to 10 MB and 16 megapixels. Square images work best.
      </p>
      <p role="status" className="min-h-5 text-xs leading-5 text-fg-muted">
        {error ?? state?.error}
      </p>
    </section>
  );
}
