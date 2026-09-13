import { shell, type WebContents } from "electron";

interface AuthorizationAttempt {
  url: string;
  label: string;
  expiresAt: number;
  cancel(): void;
}

const attempts = new Map<number, AuthorizationAttempt>();

/** Retain only the initiating URL, never a provider's intermediate redirect. */
export function trackAuthorization({
  sender,
  ...attempt
}: AuthorizationAttempt & { sender: WebContents }): () => void {
  const previous = attempts.get(sender.id);
  previous?.cancel();
  let active = true;
  const entry = { ...attempt, cancel: () => cancel() };
  attempts.set(sender.id, entry);
  if (!sender.isDestroyed()) sender.send("catamorphic:authorization-changed");
  const dispose = () => {
    active = false;
    if (attempts.get(sender.id) === entry) {
      attempts.delete(sender.id);
      if (!sender.isDestroyed())
        sender.send("catamorphic:authorization-changed");
    }
    sender.removeListener("destroyed", cancel);
    clearTimeout(timer);
  };
  const cancel = () => {
    if (!active) return;
    dispose();
    attempt.cancel();
  };
  const timer = setTimeout(cancel, Math.max(0, attempt.expiresAt - Date.now()));
  timer.unref();
  sender.once("destroyed", cancel);
  return dispose;
}

export function authorizationStatus(sender: WebContents) {
  const attempt = attempts.get(sender.id);
  return attempt
    ? { label: attempt.label, expiresAt: attempt.expiresAt }
    : null;
}

export function cancelAuthorization(sender: WebContents): void {
  const attempt = attempts.get(sender.id);
  attempt?.cancel();
}

export async function continueAuthorizationInBrowser(
  sender: WebContents,
): Promise<void> {
  const attempt = attempts.get(sender.id);
  if (!attempt || attempt.expiresAt <= Date.now()) {
    throw new Error("This sign-in attempt expired. Start sign-in again.");
  }
  const url = new URL(attempt.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web sign-in pages can open in your browser.");
  }
  await shell.openExternal(url.toString());
}
