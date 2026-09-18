import { Check, Globe } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DefaultBrowserState } from "../../shared/default-browser.js";
import { desktopApi } from "../lib/desktop-api.js";
import { PendingButton } from "./pending-button.js";

/** One OS-backed action in onboarding and Settings. No persisted pretend toggle. */
export function DefaultBrowserButton({
  className = "",
}: {
  className?: string;
}) {
  const descriptionId = useId();
  const [state, setState] = useState<DefaultBrowserState>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const generation = useRef(0);
  const requesting = useRef(false);
  const refresh = useCallback(() => {
    if (requesting.current) return;
    const current = ++generation.current;
    void desktopApi
      .defaultBrowserState()
      .then((next) => {
        if (current !== generation.current) return;
        setState(next);
        setMessage(undefined);
      })
      .catch(() => {
        if (current !== generation.current) return;
        setMessage("Could not check your default browser. Try again.");
      });
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      generation.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  const request = async () => {
    if (requesting.current) return;
    requesting.current = true;
    const current = ++generation.current;
    setPending(true);
    setMessage(undefined);
    try {
      const next = await desktopApi.defaultBrowserRequest();
      if (current !== generation.current) return;
      setState(next);
      if (!next.isDefault && next.available)
        setMessage("Choose Work in your system's default browser settings.");
    } catch {
      if (current !== generation.current) return;
      setMessage("Could not change your default browser. Try again.");
    } finally {
      requesting.current = false;
      if (current === generation.current) setPending(false);
    }
  };
  return (
    <div className={className} data-setting-id="defaultBrowser">
      <PendingButton
        pending={pending}
        pendingLabel="Opening settings…"
        done={state?.isDefault}
        doneLabel={
          <span className="inline-flex items-center gap-2">
            <Check className="size-3.5 text-success" />
            Default browser set
          </span>
        }
        disabled={state ? !state.available : false}
        data-disabled-reason={state?.reason}
        aria-describedby={descriptionId}
        onClick={() => void request()}
        data-testid="default-browser-button"
        className="browser-setup-action"
      >
        <span className="inline-flex items-center gap-2">
          <Globe className="size-3.5" />
          Make default browser
        </span>
      </PendingButton>
      <p
        id={descriptionId}
        role="status"
        className="mt-2 min-h-10 text-xs leading-5 text-fg-muted"
      >
        {state?.isDefault ? null : (state?.reason ?? message)}
      </p>
    </div>
  );
}
