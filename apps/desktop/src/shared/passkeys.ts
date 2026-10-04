/**
 * Passkeys in browser tabs (Web Authentication, ADRs 0185 and 0201).
 * Electron services a request with no UI, no timer and nowhere to keep a
 * passkey, so the guest preload wraps the API: each request keeps its
 * deadline and can be cancelled, Work answers it from the profile's vault
 * when the person picks a saved passkey (or saves a new one), and a
 * security key can still answer through Chromium. The window shows modal
 * requests in the passkey sheet; autofill requests appear in the field
 * suggestions.
 */

export type PasskeyRequestKind = "get" | "create";
export type PasskeyMediation = "modal" | "conditional";

/** A saved passkey the sheet or the field suggestions offer. */
export interface PasskeyChoice {
  id: string;
  username: string;
}

/**
 * Why Work cannot answer a request itself. A security key still can.
 * - `security-key-only`: the site asks for a security key.
 * - `verification-unavailable`: the site requires user verification and
 *   this Mac has no Touch ID to give it.
 * - `unsupported-algorithm`: the site accepts no key type Work signs with.
 * - `excluded`: the account already has a passkey saved in Work.
 * - `vault-unavailable`: the profile's vault could not be opened.
 */
export type PasskeyUnavailable =
  | "security-key-only"
  | "verification-unavailable"
  | "unsupported-algorithm"
  | "excluded"
  | "vault-unavailable";

/** A page's modal passkey request, as the window shows it. */
export interface PasskeyRequest {
  id: string;
  /** The requesting guest's webContents id (the tab it belongs to). */
  guestId: number;
  origin: string;
  /** The relying party the passkey belongs to (a domain). */
  rpId: string;
  kind: PasskeyRequestKind;
  /** The page's own icon, as its tab shows it. */
  icon?: string;
  /** Sign-in: Work's passkeys that can answer, by username. */
  passkeys: PasskeyChoice[];
  /** Creation: the account the site makes a passkey for. */
  account?: { name: string; displayName: string };
  unavailable?: PasskeyUnavailable;
  /** Touch ID confirms each use of a passkey. */
  verifies: boolean;
}

/** How using or saving a passkey from the window ended. */
export type PasskeyUseResult = "used" | "refused" | "gone";

/** A credential as the page builds its PublicKeyCredential (base64url). */
export interface PasskeyCredentialJson {
  id: string;
  type: "public-key";
  authenticatorAttachment: "platform";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    /** create */
    attestationObject?: string;
    publicKey?: string;
    publicKeyAlgorithm?: number;
    transports?: string[];
    /** get */
    signature?: string;
    userHandle?: string | null;
  };
  clientExtensionResults: { credProps?: { rk: boolean } };
}

export type PasskeyErrorName =
  | "NotAllowedError"
  | "InvalidStateError"
  | "SecurityError"
  | "NotSupportedError";

/**
 * Main's answer to a page's request: a credential, an error to reject
 * with, or `settled` when Work has nothing to add (the page or a
 * security key finished it, or another request already holds the sheet).
 */
export type PasskeyAnswer =
  | { status: "credential"; credential: PasskeyCredentialJson }
  | { status: "error"; name: PasskeyErrorName }
  | { status: "settled" };

/**
 * Chrome's bounds for a relying party's timeout: absent means five
 * minutes, and anything given is held between ten seconds and ten
 * minutes. The guest preload applies them (it cannot import this module
 * into the page's world, so they travel as arguments).
 */
export const PASSKEY_TIMEOUT_DEFAULT_MS = 5 * 60_000;
export const PASSKEY_TIMEOUT_MIN_MS = 10_000;
export const PASSKEY_TIMEOUT_MAX_MS = 10 * 60_000;
