import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Copy,
  KeyRound,
  Sparkles,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";

/**
 * Agent setup wizard — the one place agents are added. Shown as a full tab
 * (first-run onboarding when the profile has no agents) or as a modal (from
 * Settings "Add agent"). One question — which agent — with the zero-friction
 * free path last. CLI harnesses get a detail step that prefers the machine's
 * existing sign-in when `agentSetupStatus` detects one.
 */

type Step = "choose" | "claude-code" | "codex" | "api-key";
/** One create-and-sign-in path; "-account" = a separate, per-agent login. */
type Flow =
  | "claude-code"
  | "claude-code-account"
  | "codex"
  | "codex-account"
  | "free";
type AiSdkProvider = "anthropic" | "openai" | "openrouter";

const OPTIONS: Array<{
  id: "claude-code" | "codex" | "api-key" | "free";
  title: string;
  description: string;
}> = [
  {
    id: "claude-code",
    title: "Claude Code",
    description: "Uses this machine's Claude Code setup.",
  },
  {
    id: "codex",
    title: "Codex",
    description: "Sign in with ChatGPT, via the Codex CLI.",
  },
  {
    id: "api-key",
    title: "Bring an API key",
    description: "Anthropic, OpenAI, or OpenRouter key.",
  },
  {
    id: "free",
    title: "Continue with free models",
    description: "Free OpenRouter models. No API key needed.",
  },
];

export function AgentWizard({
  variant,
  open,
  onClose,
  onDone,
}: {
  variant: "tab" | "modal";
  open?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>("choose");
  const [status, setStatus] = useState<{
    claudeCode: boolean;
    codex: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // Which flow the busy state belongs to, so only the clicked button of a
  // two-choice step shows its pending label.
  const [busyFlow, setBusyFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Optional custom agent name, shared by the detail steps (each step
  // resets it on entry via goto).
  const [name, setName] = useState("");

  // Claude Code terminal sign-in.
  const [ccCommand, setCcCommand] = useState<string | null>(null);
  const [ccStarted, setCcStarted] = useState(false);
  const [copied, setCopied] = useState(false);

  // Browser sign-ins (Codex, free models) resolve out of band.
  const [waitingFlow, setWaitingFlow] = useState<Flow | null>(null);

  // API key step.
  const [provider, setProvider] = useState<AiSdkProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");

  // Agents already created by a flow, so a retry signs in again instead of
  // creating a duplicate.
  const createdRef = useRef<Partial<Record<Flow, string>>>({});
  const waitingRef = useRef<{ agentId: string; flow: Flow } | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    void desktopApi.agentSetupStatus().then(setStatus);
  }, []);

  // Reopening the modal starts the wizard over (and re-checks the machine).
  const modalOpen = variant === "modal" && open === true;
  useEffect(() => {
    if (!modalOpen) return;
    setStep("choose");
    setBusy(false);
    setBusyFlow(null);
    setError(null);
    setName("");
    setCcCommand(null);
    setCcStarted(false);
    setWaitingFlow(null);
    setApiKey("");
    setProvider("anthropic");
    waitingRef.current = null;
    void desktopApi.agentSetupStatus().then(setStatus);
  }, [modalOpen]);

  useEffect(() => {
    return desktopApi.onAgentLoginFinished(({ agentId, ok }) => {
      const waiting = waitingRef.current;
      if (!waiting || waiting.agentId !== agentId) return;
      waitingRef.current = null;
      setWaitingFlow(null);
      setBusy(false);
      setBusyFlow(null);
      if (ok) onDoneRef.current();
      else setError("Sign-in did not complete. Try again.");
    });
  }, []);

  const goto = (next: Step) => {
    setError(null);
    setBusy(false);
    setBusyFlow(null);
    setName("");
    setCcCommand(null);
    setCcStarted(false);
    setWaitingFlow(null);
    waitingRef.current = null;
    setStep(next);
  };

  /** Create the flow's agent once; retries reuse it. */
  const ensureAgent = async (flow: Flow): Promise<string> => {
    const existing = createdRef.current[flow];
    if (existing) return existing;
    const customName = name.trim() ? { name: name.trim() } : {};
    const agent =
      flow === "free"
        ? await desktopApi.agentsCreate({
            name: "Free models",
            harness: "ai-sdk",
            provider: "openrouter",
            auth: "account",
          })
        : flow === "claude-code-account"
          ? await desktopApi.agentsCreate({
              harness: "claude-code",
              auth: "account",
              ...customName,
            })
          : flow === "codex-account"
            ? await desktopApi.agentsCreate({
                harness: "codex",
                auth: "account",
                ...customName,
              })
            : await desktopApi.agentsCreate({
                harness: flow,
                auth: "local",
                ...customName,
              });
    createdRef.current[flow] = agent.id;
    return agent.id;
  };

  /** "Already set up here" path: create the local-auth agent and finish. */
  const addExistingSetup = async (flow: "claude-code" | "codex") => {
    setError(null);
    setBusy(true);
    setBusyFlow(flow);
    try {
      await ensureAgent(flow);
      onDone();
    } catch (cause) {
      setBusy(false);
      setBusyFlow(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Browser sign-in path (Codex, free models): login then wait for the
   * finished event. Stays busy while the browser round-trip is pending. */
  const startBrowserSignIn = async (
    flow: "codex" | "codex-account" | "free",
  ) => {
    setError(null);
    setBusy(true);
    setBusyFlow(flow);
    try {
      const id = await ensureAgent(flow);
      const result = await desktopApi.agentLogin(id);
      if (result.started) {
        waitingRef.current = { agentId: id, flow };
        setWaitingFlow(flow);
      } else if (result.error) {
        setBusy(false);
        setBusyFlow(null);
        setError(result.error);
      } else {
        // Nothing to start: the harness is already signed in.
        onDone();
      }
    } catch (cause) {
      setBusy(false);
      setBusyFlow(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Claude Code terminal sign-in: surfaces the CLI command to finish with. */
  const startTerminalSignIn = async (
    flow: "claude-code" | "claude-code-account",
  ) => {
    setError(null);
    setBusy(true);
    setBusyFlow(flow);
    try {
      const id = await ensureAgent(flow);
      const result = await desktopApi.agentLogin(id);
      if (result.error) {
        setError(result.error);
      } else {
        setCcStarted(true);
        if (result.command) setCcCommand(result.command);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setBusyFlow(null);
    }
  };

  const submitApiKey = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !apiKey.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await desktopApi.agentsCreate({
        harness: "ai-sdk",
        provider,
        auth: "api-key",
        apiKey: apiKey.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      onDone();
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const copyCommand = (command: string) => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  /** Optional agent name, offered on every detail step. */
  const nameField = (placeholder: string) => (
    <label className="flex flex-col gap-1 text-xs text-fg-muted">
      Name
      <input
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="field h-8 px-2 text-[13px] text-fg placeholder:text-fg-faint"
      />
    </label>
  );

  /** The terminal sign-in command block (Claude Code flows). */
  const commandBlock = ccCommand && (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-bg-inset px-2 py-1 font-mono text-[11px] text-fg-muted">
          {ccCommand}
        </code>
        <ShortcutHint label="Copy command">
          <button
            type="button"
            onClick={() => copyCommand(ccCommand)}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-muted transition-colors duration-150 hover:text-fg"
            aria-label="Copy sign-in command"
          >
            {copied ? (
              <Check className="size-3 text-success" />
            ) : (
              <Copy className="size-3" />
            )}
          </button>
        </ShortcutHint>
      </div>
      <p className="text-[11px] text-fg-faint">
        Finish sign-in in your terminal, then continue.
      </p>
    </div>
  );

  const content = (
    // Re-mounting on step swap restarts the fade-in for the new content.
    <div key={step} className="animate-fade-in">
      {step === "choose" ? (
        <>
          <div className="mb-1 flex items-center gap-2">
            <Bot className="size-4 text-fg-muted" />
            <h2 className="text-[16px] font-semibold">Choose your agent</h2>
          </div>
          <p className="mb-4 text-[13px] text-fg-muted">
            Pick an agent to power this profile's chats. You can add more or
            switch anytime in Settings or the command palette.
          </p>
          <ul className="flex flex-col gap-2" aria-label="Agent choices">
            {OPTIONS.map((option) => {
              const freePending = option.id === "free" && busy;
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (option.id === "free") void startBrowserSignIn("free");
                      else goto(option.id);
                    }}
                    data-testid={`agent-wizard-${option.id}`}
                    className="group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border bg-bg-raised px-3 py-2.5 text-left transition-colors duration-150 hover:border-border-strong hover:bg-bg-overlay disabled:cursor-default disabled:opacity-60"
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-bg-overlay text-fg-muted">
                      {option.id === "free" ? (
                        <Sparkles className="size-3.5" />
                      ) : option.id === "api-key" ? (
                        <KeyRound className="size-3.5" />
                      ) : (
                        <Bot className="size-3.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-fg">
                        {option.title}
                      </span>
                      <span className="block truncate text-[12px] text-fg-muted">
                        {freePending
                          ? waitingFlow === "free"
                            ? "Finish signing in, then come back…"
                            : "Opening your browser…"
                          : option.description}
                      </span>
                    </span>
                    <ChevronRight className="size-3.5 shrink-0 text-fg-faint transition-colors duration-150 group-hover:text-fg-muted" />
                  </button>
                </li>
              );
            })}
          </ul>
          {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}
          {variant === "tab" && (
            <p className="mt-4 text-[12px] text-fg-faint">
              Closing this tab skips setup. The wizard comes back when you start
              a chat.
            </p>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => goto("choose")}
            data-testid="agent-wizard-back"
            className="mb-3 flex cursor-pointer items-center gap-1 text-xs text-fg-muted transition-colors duration-150 hover:text-fg"
          >
            <ArrowLeft className="size-3" />
            Back
          </button>

          {step === "claude-code" &&
            (status?.claudeCode ? (
              <>
                <h2 className="text-[15px] font-semibold">
                  Claude Code is already set up on this machine
                </h2>
                <p className="mt-2 text-[13px] text-fg-muted">
                  Catamorphic can use that sign-in directly. Nothing else to
                  configure. Or sign in with a different account, kept separate
                  for this agent.
                </p>
                <div className="mt-3">{nameField("Claude Code")}</div>
                {commandBlock}
                {ccStarted ? (
                  <button
                    type="button"
                    onClick={onDone}
                    className="mt-4 h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
                  >
                    Continue
                  </button>
                ) : (
                  <div className="mt-4 flex items-center gap-2">
                    <PendingButton
                      type="button"
                      pending={busy && busyFlow === "claude-code"}
                      pendingLabel="Adding…"
                      disabled={busy}
                      onClick={() => void addExistingSetup("claude-code")}
                      className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Use my existing setup
                    </PendingButton>
                    <PendingButton
                      type="button"
                      pending={busy && busyFlow === "claude-code-account"}
                      pendingLabel="Starting…"
                      disabled={busy}
                      onClick={() =>
                        void startTerminalSignIn("claude-code-account")
                      }
                      className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Sign in with a different account
                    </PendingButton>
                  </div>
                )}
              </>
            ) : (
              <>
                <h2 className="text-[15px] font-semibold">
                  Sign in to Claude Code
                </h2>
                <p className="mt-2 text-[13px] text-fg-muted">
                  Claude Code needs a one-time sign-in from your terminal. Start
                  it here, finish it there, and you're set on this machine for
                  good.
                </p>
                <div className="mt-3">{nameField("Claude Code")}</div>
                {commandBlock}
                <div className="mt-4 flex items-center gap-2">
                  {ccStarted ? (
                    <button
                      type="button"
                      onClick={onDone}
                      className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
                    >
                      Continue
                    </button>
                  ) : (
                    <PendingButton
                      type="button"
                      pending={busy}
                      pendingLabel="Starting…"
                      onClick={() => void startTerminalSignIn("claude-code")}
                      className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Sign in in Terminal
                    </PendingButton>
                  )}
                  <button
                    type="button"
                    onClick={() => goto("api-key")}
                    className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                  >
                    Use an API key instead
                  </button>
                </div>
              </>
            ))}

          {step === "codex" &&
            (status?.codex ? (
              <>
                <h2 className="text-[15px] font-semibold">
                  Codex is already signed in on this machine
                </h2>
                <p className="mt-2 text-[13px] text-fg-muted">
                  Catamorphic can use that sign-in directly. Nothing else to
                  configure. Or sign in with a different ChatGPT account, kept
                  separate for this agent.
                </p>
                <div className="mt-3">{nameField("Codex")}</div>
                <div className="mt-4 flex items-center gap-2">
                  <PendingButton
                    type="button"
                    pending={busy && busyFlow === "codex"}
                    pendingLabel="Adding…"
                    disabled={busy}
                    onClick={() => void addExistingSetup("codex")}
                    className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Use my existing sign-in
                  </PendingButton>
                  <PendingButton
                    type="button"
                    pending={busy && busyFlow === "codex-account"}
                    pendingLabel="Opening…"
                    disabled={busy}
                    onClick={() => void startBrowserSignIn("codex-account")}
                    className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Sign in with a different ChatGPT account
                  </PendingButton>
                </div>
                {waitingFlow === "codex-account" && (
                  <p className="mt-2 text-[12px] text-fg-faint">
                    Finish signing in in your browser…
                  </p>
                )}
              </>
            ) : (
              <>
                <h2 className="text-[15px] font-semibold">
                  Sign in with ChatGPT
                </h2>
                <p className="mt-2 text-[13px] text-fg-muted">
                  Codex runs locally via the Codex CLI and signs in with your
                  ChatGPT account in the browser.
                </p>
                <div className="mt-3">{nameField("Codex")}</div>
                <PendingButton
                  type="button"
                  pending={busy}
                  pendingLabel="Opening…"
                  onClick={() => void startBrowserSignIn("codex")}
                  className="mt-4 h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Sign in with ChatGPT
                </PendingButton>
                {waitingFlow === "codex" && (
                  <p className="mt-2 text-[12px] text-fg-faint">
                    Finish signing in in your browser…
                  </p>
                )}
              </>
            ))}

          {step === "api-key" && (
            <form onSubmit={submitApiKey} className="flex flex-col gap-3">
              <h2 className="text-[15px] font-semibold">Bring an API key</h2>
              {nameField("Built-in")}
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Provider
                <select
                  value={provider}
                  onChange={(event) =>
                    setProvider(event.target.value as AiSdkProvider)
                  }
                  className="field h-8 px-2 text-[13px] text-fg"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                API key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={
                    provider === "openai"
                      ? "sk-…"
                      : provider === "openrouter"
                        ? "sk-or-…"
                        : "sk-ant-…"
                  }
                  // biome-ignore lint/a11y/noAutofocus: primary field of this step
                  autoFocus
                  autoComplete="off"
                  className="field h-8 px-2 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-fg-faint"
                />
              </label>
              <p className="text-xs text-fg-faint">
                Stored encrypted with your OS keychain. Model defaults are
                picked automatically; change them later in Settings.
              </p>
              <PendingButton
                type="submit"
                pending={busy}
                pendingLabel="Adding…"
                disabled={!apiKey.trim()}
                className="h-8 w-fit cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add agent
              </PendingButton>
            </form>
          )}

          {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}
        </>
      )}
    </div>
  );

  if (variant === "modal") {
    return (
      <Modal open={open === true} onClose={onClose}>
        <div data-testid="agent-wizard" className="px-5 py-5">
          {content}
        </div>
      </Modal>
    );
  }

  return (
    <div
      data-testid="agent-wizard"
      className="grid flex-1 place-items-center px-6"
    >
      <div className="w-full max-w-md">{content}</div>
    </div>
  );
}
