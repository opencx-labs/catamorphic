import { Check, Globe } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
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
  const refresh = useCallback(() => {
    void desktopApi
      .defaultBrowserState()
      .then(setState)
      .catch(() => {
        setMessage("Could not check your default browser. Try again.");
      });
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const request = async () => {
    if (pending) return;
    setPending(true);
    setMessage(undefined);
    try {
      const next = await desktopApi.defaultBrowserRequest();
      setState(next);
      if (!next.isDefault && next.available)
        setMessage(
          "Choose Catamorphic in your system's default browser settings.",
        );
    } catch {
      setMessage("Could not change your default browser. Try again.");
    } finally {
      setPending(false);
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
