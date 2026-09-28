/**
 * Passkeys in browser tabs (Web Authentication). Electron services a
 * request with no UI and no timer of its own: with nothing to answer it
 * (no security key, and no platform authenticator configured), the page's
 * promise never settles and every later request on the page fails as
 * already pending. The guest preload wraps the API so each request keeps
 * its deadline and can be cancelled, and the window shows the request
 * while it waits.
 */

export type PasskeyRequestKind = "get" | "create";

/** A page's modal passkey request, as the window shows it. */
export interface PasskeyRequest {
  id: string;
  /** The requesting guest's webContents id (the tab it belongs to). */
  guestId: number;
  origin: string;
  kind: PasskeyRequestKind;
  /** The page's own icon, as its tab shows it. */
  icon?: string;
}

/**
 * Chrome's bounds for a relying party's timeout: absent means five
 * minutes, and anything given is held between ten seconds and ten
 * minutes. The guest preload applies them (it cannot import this module
 * into the page's world, so they travel as arguments).
 */
export const PASSKEY_TIMEOUT_DEFAULT_MS = 5 * 60_000;
export const PASSKEY_TIMEOUT_MIN_MS = 10_000;
export const PASSKEY_TIMEOUT_MAX_MS = 10 * 60_000;
