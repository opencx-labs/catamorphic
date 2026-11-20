import { CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  type HarnessSignIn,
  type HarnessSignInState,
  type HarnessSignInStatus,
  SIGN_IN_HARNESS_NAMES,
  type SignInHarness,
} from "../../shared/remote-machines.js";
import { desktopApi } from "../lib/desktop-api.js";
import { ipcErrorText } from "../lib/remote-workspace.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

/** How often a waiting sign-in asks the server whether it finished. */
export const HARNESS_SIGN_IN_POLL_MS = 2_000;

/** Why a sign-in that ended without its own words ended. */
function endedText(input: {
  state: Exclude<HarnessSignInState, "waiting" | "signed-in">;
  /** The login waited for a pasted code rather than showing one. */
  pasted: boolean;
}): string {
  if (input.state === "failed") return "The sign-in did not finish.";
  if (input.state === "cancelled") return "The sign-in was cancelled.";
  return input.pasted
    ? "The sign-in ran out of time."
    : "The code expired before it was entered.";
}

/** The machine and harness a sign-in is for. */
export interface HarnessSignInTarget {
  id: string;
  name: string;
  harness: SignInHarness;
}

export type HarnessSignInStep =
  | { kind: "starting" }
  | { kind: "link"; signIn: HarnessSignIn }
  | { kind: "signed-in" }
  | { kind: "ended"; message: string };

interface LiveAttempt {
  projectId: string;
  machineId: string;
  harness: SignInHarness;
  attempt: string;
}

/** Best effort: an attempt nobody cancels expires on the server. */
function cancelAttempt(live: LiveAttempt) {
  void desktopApi.remoteHarnessSignInCancel(live).catch(() => undefined);
}

/** The attempt a started sign-in is, as every later request names it. */
function liveAttempt(input: {
  projectId: string;
  target: HarnessSignInTarget;
  signIn: HarnessSignIn;
}): LiveAttempt {
  return {
    projectId: input.projectId,
    machineId: input.target.id,
    harness: input.target.harness,
    attempt: input.signIn.attempt,
  };
}

/**
 * A harness's own sign-in on one of the member's machines (ADRs 0213,
 * 0340): starts it, asks the server every two seconds whether it finished,
 * hands the machine the code a person pastes when the login waits for one,
 * and cancels it when the dialog closes before it finished. An answer to an
 * attempt closed or replaced since never reaches the dialog. The pasted
 * code is sent and forgotten: it is never kept in state.
 */
export function useHarnessSignIn({
  projectId,
  onSignedIn,
}: {
  projectId: string;
  onSignedIn: (target: { machineId: string; harness: SignInHarness }) => void;
}) {
  const [target, setTarget] = useState<HarnessSignInTarget | null>(null);
  const [step, setStep] = useState<HarnessSignInStep>({ kind: "starting" });
  const [checkError, setCheckError] = useState<string | null>(null);
  // The code a login waits for: being sent, sent, or refused.
  const [code, setCode] = useState<{
    state: "idle" | "sending" | "sent";
    error: string | null;
  }>({ state: "idle", error: null });
  const [now, setNow] = useState(() => Date.now());
  const attemptRef = useRef(0);
  // The attempt still waiting, which closing cancels.
  const liveRef = useRef<LiveAttempt | null>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  /** Where a status leaves the dialog; true once the sign-in is over. */
  const settle = useCallback(
    (
      status: HarnessSignInStatus,
      live: LiveAttempt,
      signIn: HarnessSignIn,
    ): boolean => {
      if (status.state === "waiting") return false;
      liveRef.current = null;
      if (status.state === "signed-in") {
        setStep({ kind: "signed-in" });
        onSignedInRef.current({
          machineId: live.machineId,
          harness: live.harness,
        });
      } else
        setStep({
          kind: "ended",
          message:
            status.message ??
            endedText({
              state: status.state,
              pasted: signIn.expects === "code",
            }),
        });
      return true;
    },
    [],
  );

  const begin = useCallback(
    async (next: HarnessSignInTarget) => {
      attemptRef.current += 1;
      const attempt = attemptRef.current;
      setStep({ kind: "starting" });
      setCheckError(null);
      setCode({ state: "idle", error: null });
      try {
        const signIn = await desktopApi.remoteHarnessSignIn({
          projectId,
          machineId: next.id,
          harness: next.harness,
        });
        const live = liveAttempt({ projectId, target: next, signIn });
        if (attempt !== attemptRef.current) {
          // Closed while the machine started it: nobody finishes this one.
          cancelAttempt(live);
          return;
        }
        liveRef.current = live;
        setNow(Date.now());
        setStep({ kind: "link", signIn });
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
    (next: HarnessSignInTarget) => {
      abandon();
      setTarget(next);
      void begin(next);
    },
    [abandon, begin],
  );

  const retry = useCallback(() => {
    if (!target) return;
    abandon();
    void begin(target);
  }, [target, abandon, begin]);

  const close = useCallback(() => {
    abandon();
    setTarget(null);
  }, [abandon]);

  /** Send the code the sign-in page gave the person to the machine. */
  const submitCode = useCallback(
    async (text: string) => {
      const live = liveRef.current;
      if (!live || step.kind !== "link") return;
      const { signIn } = step;
      const attempt = attemptRef.current;
      setCode({ state: "sending", error: null });
      try {
        const status = await desktopApi.remoteHarnessSignInCode({
          ...live,
          text,
        });
        if (attempt !== attemptRef.current) return;
        setCode({ state: "sent", error: null });
        settle(status, live, signIn);
      } catch (cause) {
        if (attempt === attemptRef.current)
          setCode({ state: "idle", error: ipcErrorText(cause) });
      }
    },
    [settle, step],
  );

  // Leaving the screen ends whatever is still waiting.
  useEffect(() => abandon, [abandon]);

  useEffect(() => {
    if (step.kind !== "link" || !target) return;
    const attempt = attemptRef.current;
    const { signIn } = step;
    const live = liveAttempt({ projectId, target, signIn });
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped && attempt === attemptRef.current;
    const poll = async () => {
      try {
        const status = await desktopApi.remoteHarnessSignInStatus(live);
        if (!current()) return;
        setCheckError(null);
        setNow(Date.now());
        if (settle(status, live, signIn)) return;
      } catch (cause) {
        // A check that fails says so and tries again; the sign-in stays good.
        if (!current()) return;
        setCheckError(ipcErrorText(cause));
      }
      timer = setTimeout(() => void poll(), HARNESS_SIGN_IN_POLL_MS);
    };
    timer = setTimeout(() => void poll(), HARNESS_SIGN_IN_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [step, target, projectId, settle]);

  return {
    target,
    step,
    checkError,
    code,
    now,
    start,
    retry,
    close,
    submitCode,
  };
}

/** The steps of a harness sign-in on one of the member's machines. */
export function HarnessSignInDialog({
  signIn,
}: {
  signIn: ReturnType<typeof useHarnessSignIn>;
}) {
  const { target, step, checkError, code, now } = signIn;
  const titleId = useId();
  // The dialog keeps its machine through the exit animation.
  const shown = useRef<HarnessSignInTarget | null>(null);
  if (target) shown.current = target;
  const machine = shown.current?.name ?? "";
  const harness = shown.current?.harness ?? "codex";
  const { name, account } = SIGN_IN_HARNESS_NAMES[harness];
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

  const waiting =
    step.kind === "link"
      ? step.signIn.expects === "code"
        ? code.state === "sent"
          ? "Finishing the sign-in"
          : code.state === "sending"
            ? "Sending the code"
            : "Waiting for the code from the sign-in page"
        : "Waiting for you to enter the code"
      : null;

  return (
    <Modal
      open={target !== null}
      onClose={signIn.close}
      width={440}
      labelledBy={titleId}
    >
      <div
        className="flex flex-col"
        data-testid="harness-sign-in"
        data-harness={harness}
      >
        {/* About the link step's height while it is coming, so the dialog
        holds still as the link arrives. */}
        <div
          className={`flex flex-col px-5 pt-5 ${step.kind === "starting" || step.kind === "link" ? "min-h-[320px]" : ""}`}
        >
          <h2 id={titleId} className="text-sm font-semibold text-fg">
            Sign in to {name} on {machine}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {name} signs in on the machine itself, so your {account} sign-in
            stays there.
          </p>

          {/* Always present, so screen readers hear what fills it. */}
          <div aria-live="polite">
            {step.kind === "starting" && (
              <p className="mt-4 flex items-center gap-2 text-xs text-fg-muted">
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                Asking {machine} for a sign-in link
              </p>
            )}
            {step.kind === "signed-in" && (
              <>
                <p className="mt-4 flex items-center gap-2 text-[13px] text-fg">
                  <CheckCircle2 className="size-4 text-success" />
                  {name} is signed in on {machine}.
                </p>
                <p className="mt-1.5 text-xs leading-5 text-fg-muted">
                  Your {name} chats there run on your {account} plan now. You
                  can sign out here at any time.
                </p>
              </>
            )}
          </div>

          {step.kind === "link" && (
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
                {step.signIn.expects === "code" ? (
                  <li>
                    <p className="text-[13px] text-fg">
                      2. Paste the code the page gives you
                    </p>
                    <CodeField
                      // A new attempt starts with an empty field.
                      key={step.signIn.attempt}
                      name={name}
                      state={code.state}
                      onSubmit={signIn.submitCode}
                    />
                    <p className="mt-1.5 text-xs text-fg-faint">
                      {expiresIn(step.signIn.expiresAt, now)}
                    </p>
                  </li>
                ) : (
                  <li>
                    <p className="text-[13px] text-fg">2. Enter this code</p>
                    <CodeBox code={step.signIn.userCode ?? ""} />
                    <p className="mt-1.5 text-xs text-fg-faint">
                      {expiresIn(step.signIn.expiresAt, now)}
                    </p>
                  </li>
                )}
              </ol>
              <SignInHint harness={harness} />
            </>
          )}

          {step.kind === "ended" && (
            <>
              <p role="alert" className="mt-4 text-xs leading-5 text-danger">
                {step.message}
              </p>
              <SignInHint harness={harness} />
            </>
          )}
        </div>

        <footer className="mt-5 flex items-center gap-2 border-t border-border px-5 py-3.5">
          <p
            className="min-h-5 min-w-0 flex-1 text-xs leading-5 text-fg-faint"
            aria-live="polite"
            data-testid="harness-sign-in-status"
          >
            {step.kind === "link"
              ? (linkError ??
                code.error ??
                (checkError
                  ? `Could not check the sign-in: ${checkError}`
                  : waiting))
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

/**
 * Where a person pastes the code the sign-in page gave them. The field
 * holds it only until it is sent: nothing here keeps or shows it after.
 */
function CodeField({
  name,
  state,
  onSubmit,
}: {
  name: string;
  state: "idle" | "sending" | "sent";
  onSubmit: (text: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(true);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = inputRef.current;
    const text = input?.value.trim() ?? "";
    if (!input || !text || state !== "idle") return;
    // Sent once, then gone from the page.
    input.value = "";
    setEmpty(true);
    onSubmit(text);
  };
  return (
    <form
      className="mt-1.5 flex items-center gap-2"
      onSubmit={submit}
      data-testid="harness-sign-in-code-form"
    >
      <input
        ref={inputRef}
        type="password"
        onChange={(event) =>
          setEmpty(event.currentTarget.value.trim().length === 0)
        }
        disabled={state !== "idle"}
        data-disabled-reason={
          state === "sent" ? "The code was sent" : "The code is being sent"
        }
        autoComplete="off"
        spellCheck={false}
        aria-label={`Code from the ${name} sign-in page`}
        placeholder={state === "sent" ? "Code sent" : "Paste the code"}
        className="field h-8 min-w-0 flex-1 px-2.5 font-mono text-[12px]"
      />
      <PendingButton
        type="submit"
        pending={state === "sending"}
        disabled={empty || state !== "idle"}
        data-disabled-reason={
          state === "sent" ? "The code was sent" : "Paste the code first"
        }
        className="button-primary button-sm"
      >
        Submit
      </PendingButton>
    </form>
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
        data-testid="harness-sign-in-code"
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

/** What each harness's sign-in page may ask of the person first. */
function SignInHint({ harness }: { harness: SignInHarness }) {
  return (
    <p className="mt-4 text-xs leading-5 text-fg-muted">
      {harness === "codex"
        ? "If ChatGPT says device code sign-in is off, turn it on in ChatGPT under Settings, Security."
        : "Sign in with your own Claude account. Anthropic's terms for your plan apply to how you use it here."}
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
