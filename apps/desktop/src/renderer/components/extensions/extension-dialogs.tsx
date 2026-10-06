import { Puzzle } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ExtensionPrompt } from "../../../shared/extensions.js";
import { desktopApi } from "../../lib/desktop-api.js";
import { Modal } from "../modal.js";

const COPY: Record<
  ExtensionPrompt["kind"],
  {
    title: (name: string) => string;
    lead: string;
    empty: string;
    accept: string;
    decline: string;
    danger?: boolean;
  }
> = {
  install: {
    title: (name) => `Add “${name}”?`,
    lead: "It can:",
    empty: "It needs no special access.",
    accept: "Add extension",
    decline: "Cancel",
  },
  permissions: {
    title: (name) => `“${name}” wants more access`,
    lead: "It asks to:",
    empty: "It asks for no new access.",
    accept: "Allow",
    decline: "Deny",
  },
  update: {
    title: (name) => `“${name}” needs new access`,
    lead: "Its update asks to:",
    empty: "Its update asks for no new access.",
    accept: "Accept and update",
    decline: "Keep turned off",
  },
  remove: {
    title: (name) => `Remove “${name}”?`,
    lead: "",
    empty: "This removes it and the data it saved from this profile.",
    accept: "Remove",
    decline: "Cancel",
    danger: true,
  },
};

/**
 * The questions Work asks before an extension gains access (ADR 0203):
 * adding one, an optional permission it requests, an update that wants
 * more, or a removal it asked for. One centered dialog at a time; closing
 * it declines.
 */
/** The modal's exit motion (`animate-modal-out`). */
const MODAL_EXIT_MS = 170;

export function ExtensionPromptHost() {
  const [queue, setQueue] = useState<ExtensionPrompt[]>([]);
  const [shown, setShown] = useState<ExtensionPrompt | null>(null);
  // Between two prompts the dialog closes and opens again, so the next
  // question is seen arriving and a second click can't answer it unread.
  const [between, setBetween] = useState(false);
  const titleId = useId();
  const current = queue[0] ?? null;

  useEffect(() => {
    void desktopApi
      .extensionsPrompts()
      .then((pending) =>
        setQueue((existing) => [
          ...existing,
          ...pending.filter(
            (prompt) => !existing.some((entry) => entry.id === prompt.id),
          ),
        ]),
      )
      .catch(() => {});
    const stopPrompt = desktopApi.onExtensionPrompt((prompt) =>
      setQueue((existing) =>
        existing.some((entry) => entry.id === prompt.id)
          ? existing
          : [...existing, prompt],
      ),
    );
    const stopWithdrawn = desktopApi.onExtensionPromptWithdrawn(({ id }) =>
      setQueue((existing) => existing.filter((entry) => entry.id !== id)),
    );
    return () => {
      stopPrompt();
      stopWithdrawn();
    };
  }, []);

  // The dialog keeps its subject through the exit motion.
  useEffect(() => {
    if (current && !between) setShown(current);
  }, [current, between]);
  useEffect(() => {
    if (!between) return;
    const timer = window.setTimeout(() => setBetween(false), MODAL_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [between]);

  /** Answer the prompt on screen, and only that one. */
  const answer = (id: string, accept: boolean) => {
    if (!current || current.id !== id || between) return;
    setQueue((existing) => existing.filter((entry) => entry.id !== id));
    setBetween(true);
    void desktopApi.extensionsPromptAnswer({ id, accept });
  };

  const prompt = shown;
  const copy = prompt ? COPY[prompt.kind] : null;
  return (
    <Modal
      open={current !== null && !between && shown?.id === current.id}
      onClose={() => {
        if (shown) answer(shown.id, false);
      }}
      width={420}
      labelledBy={titleId}
    >
      {prompt && copy && (
        <div data-testid="extension-prompt" data-kind={prompt.kind}>
          <div className="flex items-start gap-3 px-5 pt-5">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-bg-inset">
              {prompt.iconUrl ? (
                <img
                  src={prompt.iconUrl}
                  alt=""
                  className="size-7 object-contain"
                />
              ) : (
                <Puzzle className="size-5 text-fg-muted" />
              )}
            </span>
            <h2
              id={titleId}
              className="min-w-0 flex-1 pt-2 text-[15px] font-semibold leading-5 text-fg"
            >
              {copy.title(prompt.name)}
            </h2>
          </div>
          <div className="px-5 pt-4">
            {prompt.warnings.length > 0 ? (
              <>
                {copy.lead && (
                  <p className="text-xs font-medium text-fg-muted">
                    {copy.lead}
                  </p>
                )}
                <ul
                  className="mt-2 space-y-1.5"
                  data-testid="extension-prompt-warnings"
                >
                  {prompt.warnings.map((warning) => (
                    <li
                      key={warning}
                      className="flex gap-2 text-[13px] leading-5 text-fg"
                    >
                      <span
                        className="mt-2 size-1 shrink-0 rounded-full bg-fg-faint"
                        aria-hidden="true"
                      />
                      {warning}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-[13px] leading-5 text-fg-muted">
                {copy.empty}
              </p>
            )}
          </div>
          <footer className="flex justify-end gap-2 px-5 pb-5 pt-5">
            <button
              type="button"
              className="button-ghost"
              onClick={() => answer(prompt.id, false)}
              data-testid="extension-prompt-decline"
            >
              {copy.decline}
            </button>
            <button
              type="button"
              className={copy.danger ? "button-danger" : "button-primary"}
              onClick={() => answer(prompt.id, true)}
              data-testid="extension-prompt-accept"
            >
              {copy.accept}
            </button>
          </footer>
        </div>
      )}
    </Modal>
  );
}
