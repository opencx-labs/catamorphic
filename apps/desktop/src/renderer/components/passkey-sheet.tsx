import { useQuery } from "@tanstack/react-query";
import { KeyRound, Lock, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PasskeyRequest } from "../../shared/passkeys.js";
import { siteHost } from "../../shared/site-settings.js";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { ShortcutHint } from "./shortcut-hint.js";
import { SiteFavicon } from "./site-favicon.js";

/**
 * A page waiting on a passkey (shared/passkeys.ts). Electron draws nothing
 * for Web Authentication, so without this the page just spins. The sheet
 * says what can answer here (a security key), what cannot yet (passkeys
 * on a phone, in iCloud Keychain or a password manager), and cancels, which
 * hands the page Chrome's NotAllowedError so it offers its other ways in.
 * It closes by itself when the request settles.
 */
export function PasskeyHost() {
  const [requests, setRequests] = useState<PasskeyRequest[]>([]);
  useEffect(() => {
    const stopRequests = desktopApi.onPasskeyRequest((request) =>
      setRequests((queue) => [...queue, request]),
    );
    const stopSettled = desktopApi.onPasskeySettled(({ ids }) =>
      setRequests((queue) =>
        queue.filter((request) => !ids.includes(request.id)),
      ),
    );
    return () => {
      stopRequests();
      stopSettled();
    };
  }, []);
  const request = requests[0] ?? null;
  const cancel = () => {
    if (!request) return;
    setRequests((queue) => queue.filter((entry) => entry.id !== request.id));
    void desktopApi.passkeyCancel({ id: request.id }).catch(() => {});
  };
  return (
    <Modal
      open={request !== null}
      onClose={cancel}
      width={420}
      labelledBy="passkey-sheet-title"
    >
      {request && (
        <PasskeySheet key={request.id} request={request} onCancel={cancel} />
      )}
    </Modal>
  );
}

function PasskeySheet({
  request,
  onCancel,
}: {
  request: PasskeyRequest;
  onCancel: () => void;
}) {
  const host = siteHost(request.origin);
  const secure = request.origin.startsWith("https:");
  // Signing in to connect Work itself can finish in the usual browser
  // (ADR 0137), which has the person's passkeys.
  const attempt = useQuery({
    queryKey: ["desktop", "authorization"],
    queryFn: () => desktopApi.authorizationStatus(),
    staleTime: 0,
  });
  const [handingOff, setHandingOff] = useState(false);
  const continueInBrowser = async () => {
    setHandingOff(true);
    try {
      await desktopApi.authorizationContinueBrowser();
      onCancel();
    } finally {
      setHandingOff(false);
    }
  };
  return (
    <div className="p-5" data-testid="passkey-sheet">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg-overlay">
          <SiteFavicon
            url={request.origin}
            faviconUrl={request.icon}
            className="size-4"
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="passkey-sheet-title"
            className="truncate text-sm font-semibold text-fg"
          >
            {host}
          </h2>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-fg-muted">
            {secure ? (
              <>
                <Lock className="size-3 shrink-0" />
                Secure connection
              </>
            ) : (
              "Not secure"
            )}
          </p>
        </div>
        <ShortcutHint label="Cancel" shortcut="Esc">
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel passkey request"
            className="-mr-1 -mt-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </ShortcutHint>
      </div>

      <div className="mt-4 rounded-lg border border-accent/30 bg-accent/8 p-4 animate-fade-in">
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-bg-raised">
            <KeyRound className="size-4 text-accent" />
          </span>
          <div className="min-w-0 flex-1 pt-1">
            <p className="text-[13px] leading-5 text-fg">
              <span className="font-medium">{host}</span>{" "}
              {request.kind === "get"
                ? "wants you to sign in with a passkey"
                : "wants to create a passkey"}
            </p>
            <p
              className="mt-1 flex items-center gap-1.5 text-[12px] leading-4 text-fg-muted"
              data-testid="passkey-sheet-waiting"
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent"
              />
              Waiting for a security key. Insert it and touch it.
            </p>
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-4 text-fg-muted">
          Passkeys saved on your phone, in iCloud Keychain or in a password
          manager can't be used in Work yet. Cancel to choose another way to{" "}
          {request.kind === "get" ? "sign in" : "continue"}.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="button-primary"
            data-testid="passkey-sheet-cancel"
          >
            Cancel
          </button>
          {attempt.data && (
            <button
              type="button"
              disabled={handingOff}
              data-disabled-reason="Opening your browser"
              onClick={() => void continueInBrowser()}
              className="button-secondary"
              data-testid="passkey-sheet-continue-browser"
            >
              Continue in your browser
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
