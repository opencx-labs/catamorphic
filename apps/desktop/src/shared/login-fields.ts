/**
 * Login field classification for the browser's password manager. Pure,
 * so the guest preload and tests share one set of rules. Sites label
 * fields inconsistently; the order of evidence follows Chrome: explicit
 * `autocomplete` tokens first, then the form's shape (two or more
 * password fields is a sign-up or change form), then names and labels.
 */

export type LoginFieldKind = "username" | "current-password" | "new-password";

export interface FieldDescriptor {
  type: string;
  autocomplete: string;
  /** name, id, placeholder, aria-label and label text, joined. */
  hints: string;
}

const NEW_PASSWORD_HINT =
  /new|confirm|repeat|retype|again|verify|create|sign.?up|register|choose/i;
const SIGN_UP_FORM_HINT =
  /sign.?up|register|create[\s_-]*(an?\s+|your\s+)?account|join|get started/i;
const NOT_A_USERNAME =
  /search|otp|one.?time|captcha|code|coupon|promo|zip|postal|city|street|query/i;
const USERNAME_HINT = /user|e.?mail|login|log.?in|account|identifier|handle/i;
const TEXT_LIKE = new Set(["text", "email", "tel", ""]);

function tokens(autocomplete: string): string[] {
  return autocomplete.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether a password field wants a new password. `index` and `count`
 * place it among the visible password fields of its form; `formHints`
 * is the form's id, action and submit button text.
 */
export function classifyPasswordField({
  field,
  index,
  count,
  formHints,
}: {
  field: FieldDescriptor;
  index: number;
  count: number;
  formHints: string;
}): "current-password" | "new-password" {
  const auto = tokens(field.autocomplete);
  if (auto.includes("new-password")) return "new-password";
  if (auto.includes("current-password")) return "current-password";
  // Change-password forms: current, new, confirm.
  if (count >= 3) return index === 0 ? "current-password" : "new-password";
  if (count === 2) return "new-password";
  if (NEW_PASSWORD_HINT.test(field.hints)) return "new-password";
  if (SIGN_UP_FORM_HINT.test(formHints)) return "new-password";
  return "current-password";
}

/** A text-like field that can hold the account name beside a password. */
export function isUsernameCandidate(field: FieldDescriptor): boolean {
  if (!TEXT_LIKE.has(field.type.toLowerCase())) return false;
  const auto = tokens(field.autocomplete);
  if (auto.includes("username") || auto.includes("email")) return true;
  if (auto.includes("one-time-code") || auto.includes("off")) {
    return USERNAME_HINT.test(field.hints) && !NOT_A_USERNAME.test(field.hints);
  }
  return !NOT_A_USERNAME.test(field.hints);
}

/**
 * A username field standing alone, the first step of an email-first
 * sign-in. Stricter than a field beside a password: it must say so.
 */
export function isStandaloneUsername(field: FieldDescriptor): boolean {
  if (!TEXT_LIKE.has(field.type.toLowerCase())) return false;
  const auto = tokens(field.autocomplete);
  if (auto.includes("username")) return true;
  if (NOT_A_USERNAME.test(field.hints)) return false;
  return (
    (field.type === "email" || auto.includes("email")) &&
    USERNAME_HINT.test(field.hints)
  );
}
