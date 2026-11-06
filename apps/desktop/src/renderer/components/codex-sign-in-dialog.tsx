import { CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  CodexSignIn,
  CodexSignInState,
} from "../../shared/remote-machines.js";
import { desktopApi } from "../lib/desktop-api.js";
import { ipcErrorText } from "../lib/remote-workspace.js";
import { Modal } from "./modal.js";

/** How often a waiting sign-in asks the server whether it finished. */
export const CODEX_SIGN_IN_POLL_MS = 2_000;

const ENDED: Record<
  Exclude<CodexSignInState, "waiting" | "signed-in">,
  string
> = {
  failed: "The sign-in did not finish.",
  expired: "The code expired before it was entered.",
  cancelled: "The sign-in was cancelled.",
};

/** The machine a sign-in is for. */
export interface CodexSignInMachine {
  id: string;
  name: string;
}

export type CodexSignInStep =
  | { kind: "starting" }
  | { kind: "code"; signIn: CodexSignIn }
  | { kind: "signed-in" }
  | { kind: "ended"; message: string };

interface LiveAttempt {
  projectId: string;
  machineId: string;
  attempt: string;
}

/** Best effort: an attempt nobody cancels expires on the server. */
function cancelAttempt(live: LiveAttempt) {
  void desktopApi.remoteCodexSignInCancel(live).catch(() => undefined);
}

/**
 * Codex's device code sign-in on one of the member's machines (ADR 0213):
 * starts it, asks the server every two seconds whether the code was
 * entered, and cancels it when the dialog closes before it finished. An
 * answer to an attempt closed or replaced since never reaches the dialog.
 */
export function useCodexSignIn({
  projectId,
  onSignedIn,
}: {
  projectId: string;
  onSignedIn: (machineId: string) => void;
}) {
  const [machine, setMachine] = useState<CodexSignInMachine | null>(null);
  const [step, setStep] = useState<CodexSignInStep>({ kind: "starting" });
  const [checkError, setCheckError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const attemptRef = useRef(0);
  // The attempt waiting for its code, which closing cancels.
  const liveRef = useRef<LiveAttempt | null>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  const begin = useCallback(
    async (target: CodexSignInMachine) => {
      attemptRef.current += 1;
      const attempt = attemptRef.current;
      setStep({ kind: "starting" });
      setCheckError(null);
      try {
        const signIn = await desktopApi.remoteCodexSignIn({
          projectId,
          machineId: target.id,
        });
        const live = {
          projectId,
          machineId: target.id,
          attempt: signIn.attempt,
        };
        if (attempt !== attemptRef.current) {
          // Closed while the machine started it: nobody enters this code.
          cancelAttempt(live);
          return;
        }
        liveRef.current = live;
        setNow(Date.now());
        setStep({ kind: "code", signIn });
      } catch (cause) {
        if (attempt === attemptRef.current)
          setStep({ kind: "ended", message: ipcErrorText(cause) });
      }
    },
    [projectId],
  );

  const abandon = useCallback(() => {
    attemptRef.current += 1;
    const live = liveRef.current;
    liveRef.current = null;
    if (live) cancelAttempt(live);
  }, []);

  const start = useCallback(
    (target: CodexSignInMachine) => {
      abandon();
      setMachine(target);
      void begin(target);
    },
    [abandon, begin],
  );

  const retry = useCallback(() => {
    if (!machine) return;
    abandon();
    void begin(machine);
  }, [machine, abandon, begin]);

  const close = useCallback(() => {
    abandon();
    setMachine(null);
  }, [abandon]);

  // Leaving the screen ends whatever is still waiting.
  useEffect(() => abandon, [abandon]);

  useEffect(() => {
    if (step.kind !== "code" || !machine) return;
    const attempt = attemptRef.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped && attempt === attemptRef.current;
    const poll = async () => {
      try {
        const status = await desktopApi.remoteCodexSignInStatus({
          projectId,
          machineId: machine.id,
          attempt: step.signIn.attempt,
        });
        if (!current()) return;
        setCheckError(null);
        setNow(Date.now());
        if (status.state === "signed-in") {
          liveRef.current = null;
          setStep({ kind: "signed-in" });
          onSignedInRef.current(machine.id);
          return;
        }
        if (status.state !== "waiting") {
          liveRef.current = null;
          setStep({
            kind: "ended",
            message: status.message ?? ENDED[status.state],
          });
          return;
        }
      } catch (cause) {
        // A check that fails says so and tries again; the code stays good.
        if (!current()) return;
        setCheckError(ipcErrorText(cause));
      }
      timer = setTimeout(() => void poll(), CODEX_SIGN_IN_POLL_MS);
    };
    timer = setTimeout(() => void poll(), CODEX_SIGN_IN_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [step, machine, projectId]);

  return { machine, step, checkError, now, start, retry, close };
}

/** The steps of a Codex sign-in on one of the member's machines. */
export function CodexSignInDialog({
  signIn,
}: {
  signIn: ReturnType<typeof useCodexSignIn>;
}) {
  const { machine, step, checkError, now } = signIn;
  const titleId = useId();
  // The dialog keeps its machine through the exit animation.
  const shown = useRef<CodexSignInMachine | null>(null);
  if (machine) shown.current = machine;
  const name = shown.current?.name ?? "";
  const [linkError, setLinkError] = useState<string | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setLinkError(null);
    // Keyboard focus moves to what each step asks for next.
    if (step.kind !== "starting") actionRef.current?.focus();
  }, [step]);

  const openLink = (url: string) => {
    setLinkError(null);
    desktopApi
      .openSignInLink(url)
      .catch((cause: unknown) => setLinkError(ipcErrorText(cause)));
  };

  return (
    <Modal
      open={machine !== null}
      onClose={signIn.close}
      width={440}
      labelledBy={titleId}
    >
      <div className="flex flex-col" data-testid="codex-sign-in">
        {/* About the code step's height while it is coming, so the dialog
        holds still as the code arrives. */}
        <div
          className={`flex flex-col px-5 pt-5 ${step.kind === "starting" || step.kind === "code" ? "min-h-[320px]" : ""}`}
        >
          <h2 id={titleId} className="text-sm font-semibold text-fg">
            Sign in to Codex on {name}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Codex signs in on the machine itself, so your ChatGPT sign-in stays
            there.
          </p>

          {/* Always present, so screen readers hear what fills it. */}
          <div aria-live="polite">
            {step.kind === "starting" && (
              <p className="mt-4 flex items-center gap-2 text-xs text-fg-muted">
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                Asking {name} for a code
              </p>
            )}
            {step.kind === "signed-in" && (
              <>
                <p className="mt-4 flex items-center gap-2 text-[13px] text-fg">
                  <CheckCircle2 className="size-4 text-success" />
                  Codex is signed in on {name}.
                </p>
                <p className="mt-1.5 text-xs leading-5 text-fg-muted">
                  Your Codex chats there run on your ChatGPT plan now. You can
                  sign out here at any time.
                </p>
              </>
            )}
          </div>

          {step.kind === "code" && (
            <>
              <ol className="mt-4 flex flex-col gap-4">
                <li>
                  <p className="text-[13px] text-fg">
                    1. Open the sign-in page
                  </p>
                  <div className="mt-1.5 flex items-center gap-3">
                    <p
                      className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted"
                      title={step.signIn.verificationUrl}
                    >
                      {step.signIn.verificationUrl.replace(/^https:\/\//, "")}
                    </p>
                    <button
                      ref={actionRef}
                      type="button"
                      onClick={() => openLink(step.signIn.verificationUrl)}
                      className="button-secondary button-sm"
                    >
                      <ExternalLink className="size-3.5" />
                      Open sign-in page
                    </button>
                  </div>
                </li>
                <li>
                  <p className="text-[13px] text-fg">2. Enter this code</p>
                  <CodeBox code={step.signIn.userCode} />
                  <p className="mt-1.5 text-xs text-fg-faint">
                    {expiresIn(step.signIn.expiresAt, now)}
                  </p>
                </li>
              </ol>
              <DeviceCodeHint />
            </>
          )}

          {step.kind === "ended" && (
            <>
              <p role="alert" className="mt-4 text-xs leading-5 text-danger">
                {step.message}
              </p>
              <DeviceCodeHint />
            </>
          )}
        </div>

        <footer className="mt-5 flex items-center gap-2 border-t border-border px-5 py-3.5">
          <p
            className="min-h-5 min-w-0 flex-1 text-xs leading-5 text-fg-faint"
            aria-live="polite"
            data-testid="codex-sign-in-status"
          >
            {step.kind === "code"
              ? (linkError ??
                (checkError
                  ? `Could not check the sign-in: ${checkError}`
                  : "Waiting for you to enter the code"))
              : null}
          </p>
          {step.kind === "signed-in" ? (
            <button
              ref={actionRef}
              type="button"
              onClick={signIn.close}
              className="button-primary"
            >
              Done
            </button>
          ) : step.kind === "ended" ? (
            <>
              <button
                type="button"
                onClick={signIn.close}
                className="button-ghost"
              >
                Close
              </button>
              <button
                ref={actionRef}
                type="button"
                onClick={signIn.retry}
                className="button-primary"
              >
                Try again
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={signIn.close}
              className="button-ghost"
            >
              Cancel
            </button>
          )}
        </footer>
      </div>
    </Modal>
  );
}

/** The one-time code, large, with a copy button that keeps its size. */
function CodeBox({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return (
    <div className="mt-1.5 flex items-center gap-3 rounded-lg bg-bg-inset px-3 py-2.5">
      <p
        className="min-w-0 flex-1 font-mono text-xl font-semibold tracking-[0.12em] text-fg"
        data-testid="codex-sign-in-code"
      >
        <span aria-hidden="true">{code}</span>
        <span className="sr-only">{spelled(code)}</span>
      </p>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy the code"
        className="button-secondary button-sm"
      >
        <span className="grid min-w-max shrink-0 place-items-center whitespace-nowrap">
          <span
            className={`col-start-1 row-start-1 flex items-center gap-1.5 ${copied ? "invisible" : ""}`}
          >
            <Copy className="size-3.5" />
            Copy
          </span>
          <span
            className={`col-start-1 row-start-1 flex items-center gap-1.5 ${copied ? "" : "invisible"}`}
          >
            <CheckCircle2 className="size-3.5 text-success" />
            Copied
          </span>
        </span>
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Code copied" : ""}
      </span>
    </div>
  );
}

function DeviceCodeHint() {
  return (
    <p className="mt-4 text-xs leading-5 text-fg-muted">
      If ChatGPT says device code sign-in is off, turn it on in ChatGPT under
      Settings, Security.
    </p>
  );
}

/** The code one character at a time, as a screen reader should say it. */
function spelled(code: string): string {
  return Array.from(code)
    .map((character) => (character === "-" ? "dash" : character))
    .join(" ");
}

function expiresIn(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1
    ? "Expires in a minute"
    : `Expires in ${minutes} minutes`;
}
