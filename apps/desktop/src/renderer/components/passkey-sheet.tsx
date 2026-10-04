import { useQuery } from "@tanstack/react-query";
import { Fingerprint, KeyRound, Lock, Usb, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  PasskeyRequest,
  PasskeyUseResult,
} from "../../shared/passkeys.js";
import { siteHost } from "../../shared/site-settings.js";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";
import { SiteFavicon } from "./site-favicon.js";

/**
 * A page asking for a passkey (shared/passkeys.ts, ADR 0201). Signing in
 * lists the profile's passkeys for the site; creating offers to save the
 * new passkey in Work. Either way Touch ID confirms, and a security key
 * can still answer. Cancel hands the page Chrome's NotAllowedError, so it
 * offers its other ways in. The sheet closes by itself when the request
 * settles.
 */
export function PasskeyHost({
  onOpenPasswords,
}: {
  /** The Passwords page, where passkeys are imported. */
  onOpenPasswords?: () => void;
}) {
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
        <PasskeySheet
          key={request.id}
          request={request}
          onCancel={cancel}
          onOpenPasswords={
            onOpenPasswords
              ? () => {
                  cancel();
                  onOpenPasswords();
                }
              : undefined
          }
        />
      )}
    </Modal>
  );
}

/** What the sheet says when Work cannot answer, by reason. */
function unavailableText(request: PasskeyRequest, host: string): string {
  const signIn = request.kind === "get";
  switch (request.unavailable) {
    case "security-key-only":
      return `${host} asks for a security key, so passkeys saved in Work aren't offered.`;
    case "verification-unavailable":
      return `${host} requires Touch ID to ${signIn ? "sign in with" : "save"} a passkey, and Touch ID isn't available on this Mac.`;
    case "unsupported-algorithm":
      return `${host} asks for a kind of passkey Work can't create.`;
    case "vault-unavailable":
      return "Work can't open this profile's saved passkeys right now. Check that your Mac's keychain is unlocked.";
    default:
      return `No passkey for ${request.rpId} is saved in Work. Passkeys from Bitwarden or KeePassXC can be imported in Passwords. Passkeys on your phone or in iCloud Keychain can't be used in Work yet.`;
  }
}

function PasskeySheet({
  request,
  onCancel,
  onOpenPasswords,
}: {
  request: PasskeyRequest;
  onCancel: () => void;
  onOpenPasswords?: () => void;
}) {
  const host = siteHost(request.origin);
  const secure = request.origin.startsWith("https:");
  const signIn = request.kind === "get";
  const excluded = request.unavailable === "excluded";
  // Work itself can answer: a saved passkey to pick, or one to save.
  const offersWork =
    !request.unavailable && (!signIn || request.passkeys.length > 0);
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

  /** The passkey (or "save") Touch ID is confirming now. */
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = async (key: string, run: () => Promise<PasskeyUseResult>) => {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      const result = await run();
      // `used` and `gone` both end the request; the sheet closes as it
      // settles. `refused` keeps it open to try again.
      if (result === "refused")
        setError(
          request.verifies
            ? "Touch ID didn't confirm it. Try again."
            : "That didn't go through. Try again.",
        );
    } catch {
      setError("That didn't go through. Try again.");
    } finally {
      setPending(null);
    }
  };

  // The first choice takes focus, so Enter answers at once.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      rootRef.current
        ?.querySelector<HTMLElement>("[data-first-choice]")
        ?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  const account = request.account;
  const accountName = account?.name || account?.displayName || "";
  return (
    <div ref={rootRef} className="p-5" data-testid="passkey-sheet">
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
          <p className="min-w-0 flex-1 pt-1.5 text-[13px] leading-5 text-fg">
            <span className="font-medium">{host}</span>{" "}
            {signIn
              ? "wants you to sign in with a passkey"
              : "wants to create a passkey"}
          </p>
        </div>

        {signIn && offersWork && (
          <fieldset className="mt-3 space-y-1">
            <legend className="sr-only">Passkeys saved in Work</legend>
            {request.passkeys.map((passkey, index) => (
              <button
                key={passkey.id}
                data-first-choice={index === 0 || undefined}
                type="button"
                disabled={pending !== null}
                data-disabled-reason="Waiting for Touch ID"
                data-testid="passkey-sheet-choice"
                onClick={() =>
                  void answer(passkey.id, () =>
                    desktopApi.passkeyUse({
                      id: request.id,
                      passkeyId: passkey.id,
                    }),
                  )
                }
                className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-border bg-bg-raised px-3 py-2 text-left transition-colors duration-150 hover:bg-bg-overlay disabled:cursor-default"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">
                    {passkey.username || "No username"}
                  </span>
                  <span className="block text-[11px] text-fg-muted">
                    Passkey saved in Work
                  </span>
                </span>
                {pending === passkey.id ? (
                  <span className="text-[11px] text-fg-muted">
                    {request.verifies ? "Waiting for Touch ID…" : "Signing in…"}
                  </span>
                ) : (
                  request.verifies && (
                    <Fingerprint className="size-4 shrink-0 text-fg-faint" />
                  )
                )}
              </button>
            ))}
          </fieldset>
        )}

        {!signIn && (offersWork || excluded) && accountName && (
          <div className="mt-3 flex items-center gap-3 rounded-md border border-border bg-bg-raised px-3 py-2">
            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-[13px] text-fg"
                data-testid="passkey-sheet-account"
              >
                {accountName}
              </span>
              {account?.displayName && account.displayName !== accountName && (
                <span className="block truncate text-[11px] text-fg-muted">
                  {account.displayName}
                </span>
              )}
            </span>
          </div>
        )}

        <p className="mt-3 text-[12px] leading-4 text-fg-muted">
          {excluded
            ? "A passkey for this account is already saved in Work."
            : offersWork
              ? signIn
                ? request.verifies
                  ? "Touch ID confirms it's you."
                  : "Choose the account to sign in with."
                : request.verifies
                  ? "Saved in Work for this profile. Touch ID confirms it's you each time you sign in."
                  : "Saved in Work for this profile."
              : unavailableText(request, host)}
        </p>

        {!excluded && (
          <p
            className="mt-2 flex items-center gap-1.5 text-[12px] leading-4 text-fg-muted"
            data-testid="passkey-sheet-waiting"
          >
            {offersWork ? (
              <Usb aria-hidden className="size-3 shrink-0" />
            ) : (
              <span
                aria-hidden
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent"
              />
            )}
            {offersWork
              ? "Or use a security key: insert it and touch it."
              : "Waiting for a security key. Insert it and touch it."}
          </p>
        )}

        {/* Reserved so an error never moves the buttons. */}
        <p
          className="mt-2 min-h-4 text-[12px] leading-4 text-danger"
          role={error ? "alert" : undefined}
          data-testid="passkey-sheet-error"
        >
          {error}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!signIn && offersWork && (
            <PendingButton
              data-first-choice
              pending={pending === "save"}
              pendingLabel="Saving…"
              onClick={() =>
                void answer("save", () =>
                  desktopApi.passkeySave({ id: request.id }),
                )
              }
              className="button-primary"
              data-testid="passkey-sheet-save"
            >
              Save passkey
            </PendingButton>
          )}
          <button
            data-first-choice={!offersWork || undefined}
            type="button"
            onClick={onCancel}
            className={
              excluded || !offersWork ? "button-primary" : "button-secondary"
            }
            data-testid="passkey-sheet-cancel"
          >
            {excluded ? "OK" : "Cancel"}
          </button>
          {signIn && !offersWork && !request.unavailable && onOpenPasswords && (
            <button
              type="button"
              onClick={onOpenPasswords}
              className="button-secondary"
              data-testid="passkey-sheet-import"
            >
              Import passkeys
            </button>
          )}
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
