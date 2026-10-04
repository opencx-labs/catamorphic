import { randomBytes } from "node:crypto";
import { ipcMain, type WebContents, webContents } from "electron";
import { z } from "zod";
import type {
  PasskeyAnswer,
  PasskeyChoice,
  PasskeyRequest,
  PasskeyUnavailable,
  PasskeyUseResult,
} from "../shared/passkeys.js";
import { siteOrigin } from "../shared/site-settings.js";
import type { PasswordVault, SavedPasskey } from "./browser-vault.js";
import {
  assertionResponse,
  FLAG,
  fromBase64Url,
  generatePasskeyKey,
  isPasskeyAlgorithm,
  type PasskeyAlgorithm,
  readPrivateKey,
  registrationResponse,
  validRelyingParty,
} from "./webauthn.js";

/**
 * Passkey requests from browser tabs (shared/passkeys.ts, ADR 0201). The
 * guest preload hands each request here as the page makes it; main
 * checks the relying party against the page's own origin, finds the
 * profile's passkeys for it, and shows modal requests in the window
 * that shows the tab. When the person picks a passkey (or saves a new
 * one), Touch ID confirms it and main signs, so private keys never leave
 * this process. Autofill requests wait here until the person picks a
 * passkey under a field. A page that navigates or closes takes its
 * requests with it. Returns the disposer.
 */

const binary = z
  .string()
  .max(4096)
  .regex(/^[\w-]*$/);
const descriptor = z.object({
  type: z.string(),
  id: binary,
  transports: z.array(z.string()).optional(),
});
const userVerification = z.string().optional();
const createOptions = z.object({
  challenge: binary,
  rp: z.object({ id: z.string().max(253).optional(), name: z.string() }),
  user: z.object({
    id: binary,
    name: z.string().max(1024),
    displayName: z.string().max(1024),
  }),
  pubKeyCredParams: z
    .array(z.object({ type: z.string(), alg: z.number() }))
    .max(64),
  excludeCredentials: z.array(descriptor).max(256).optional(),
  authenticatorSelection: z
    .object({
      authenticatorAttachment: z.string().optional(),
      userVerification,
    })
    .optional(),
  extensions: z.object({ credProps: z.boolean().optional() }).optional(),
});
const getOptions = z.object({
  challenge: binary,
  rpId: z.string().max(253).optional(),
  allowCredentials: z.array(descriptor).max(256).optional(),
  userVerification,
});
const beginInput = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().uuid(),
    kind: z.literal("create"),
    mediation: z.literal("modal"),
    icon: z.string().max(2048).optional(),
    focused: z.boolean(),
    options: createOptions,
  }),
  z.object({
    id: z.string().uuid(),
    kind: z.literal("get"),
    mediation: z.enum(["modal", "conditional"]),
    icon: z.string().max(2048).optional(),
    focused: z.boolean(),
    options: getOptions,
  }),
]);
type BeginInput = z.infer<typeof beginInput>;

interface Pending {
  id: string;
  guest: WebContents;
  profileId: string;
  origin: string;
  rpId: string;
  input: BeginInput;
  /** Modal requests: the window showing the sheet. */
  host: WebContents | null;
  request: PasskeyRequest | null;
  /** Creation: the key type the site accepts that Work signs with. */
  algorithm: PasskeyAlgorithm | null;
  resolve: (answer: PasskeyAnswer) => void;
  /** Touch ID is up for this request; a second pick waits its turn. */
  busy: boolean;
}

export function registerPasskeys({
  vault,
  profileFor,
  onVaultChanged,
}: {
  vault: PasswordVault;
  /** The profile a window belongs to. */
  profileFor: (host: WebContents) => string;
  onVaultChanged: (profileId: string) => void;
}): () => void {
  const pending = new Map<string, Pending>();
  const watched = new Set<number>();

  const settle = (
    ids: string[],
    answer: PasskeyAnswer = { status: "settled" },
  ) => {
    const byHost = new Map<WebContents, string[]>();
    for (const id of ids) {
      const entry = pending.get(id);
      if (!entry) continue;
      pending.delete(id);
      entry.resolve(answer);
      if (entry.host)
        byHost.set(entry.host, [...(byHost.get(entry.host) ?? []), id]);
    }
    for (const [host, settled] of byHost)
      if (!host.isDestroyed())
        host.send("catamorphic:passkey-settled", { ids: settled });
  };
  const settleGuest = (guestId: number) =>
    settle(
      [...pending.values()]
        .filter((entry) => entry.guest.id === guestId)
        .map((entry) => entry.id),
    );
  const watch = (guest: WebContents) => {
    if (watched.has(guest.id)) return;
    watched.add(guest.id);
    const guestId = guest.id;
    guest.on("did-navigate", () => settleGuest(guestId));
    guest.once("destroyed", () => {
      watched.delete(guestId);
      settleGuest(guestId);
    });
  };

  /** The saved passkeys a sign-in may use, as the site narrowed them. */
  const candidates = async (entry: Pending): Promise<SavedPasskey[]> => {
    if (entry.input.kind !== "get") return [];
    const allowed = new Set(
      (entry.input.options.allowCredentials ?? []).map(
        (credential) => credential.id,
      ),
    );
    return (await vault.listPasskeys(entry.profileId, entry.rpId)).filter(
      (passkey) =>
        allowed.size > 0
          ? allowed.has(passkey.credentialId)
          : passkey.discoverable,
    );
  };
  const choices = (passkeys: SavedPasskey[]): PasskeyChoice[] =>
    passkeys.map(({ id, username }) => ({ id, username }));

  const verificationRequired = (entry: Pending) =>
    (entry.input.kind === "get"
      ? entry.input.options.userVerification
      : entry.input.options.authenticatorSelection?.userVerification) ===
    "required";

  /** What keeps Work from answering a request itself, if anything. */
  const unavailable = async (
    entry: Pending,
  ): Promise<PasskeyUnavailable | undefined> => {
    if (verificationRequired(entry) && !vault.canVerifyUser())
      return "verification-unavailable";
    if (entry.input.kind !== "create") return undefined;
    const options = entry.input.options;
    if (
      options.authenticatorSelection?.authenticatorAttachment ===
      "cross-platform"
    )
      return "security-key-only";
    if (!entry.algorithm) return "unsupported-algorithm";
    const excluded = new Set(
      (options.excludeCredentials ?? []).map((credential) => credential.id),
    );
    if (excluded.size > 0) {
      const saved = await vault.listPasskeys(entry.profileId, entry.rpId);
      if (saved.some((passkey) => excluded.has(passkey.credentialId)))
        return "excluded";
    }
    return undefined;
  };

  /**
   * Touch ID for one use. Without Touch ID the click that picked the
   * passkey is the user's presence, and the response says unverified.
   */
  const verify = async (
    entry: Pending,
    reason: string,
  ): Promise<"verified" | "present" | null> => {
    const outcome = await vault.verifyUser(reason);
    if (outcome === "verified") return "verified";
    if (outcome === "unavailable" && !verificationRequired(entry))
      return "present";
    return null;
  };

  const flagsFor = (
    verified: "verified" | "present",
    backup: { eligible: boolean; backedUp: boolean },
  ) =>
    FLAG.userPresent |
    (verified === "verified" ? FLAG.userVerified : 0) |
    (backup.eligible ? FLAG.backupEligible : 0) |
    (backup.backedUp ? FLAG.backedUp : 0);

  /** The page that asked is still the page in the tab. */
  const stillAsking = (entry: Pending) =>
    pending.get(entry.id) === entry &&
    !entry.guest.isDestroyed() &&
    siteOrigin(entry.guest.getURL()) === entry.origin;

  const signIn = async (
    entry: Pending,
    passkeyId: string,
  ): Promise<PasskeyUseResult> => {
    if (entry.input.kind !== "get") return "gone";
    // Claimed before any await, so a double click raises one Touch ID.
    if (entry.busy) return "refused";
    entry.busy = true;
    try {
      if (
        !(await candidates(entry)).some((passkey) => passkey.id === passkeyId)
      )
        return "gone";
      const secret = await vault.passkeySecret(entry.profileId, passkeyId);
      const key = secret ? readPrivateKey(secret.privateKeyPem) : null;
      if (!secret || !key) return "gone";
      const verified = await verify(
        entry,
        `sign in to ${entry.rpId} with a passkey`,
      );
      if (!stillAsking(entry)) return "gone";
      if (!verified) return "refused";
      const counter = await vault.nextPasskeyCounter(
        entry.profileId,
        passkeyId,
      );
      const credential = assertionResponse({
        rpId: entry.rpId,
        origin: entry.origin,
        challenge: fromBase64Url(entry.input.options.challenge),
        credentialId: secret.credentialId,
        userHandle: secret.userHandle,
        privateKey: key.key,
        counter,
        flags: flagsFor(verified, {
          eligible: secret.backupEligible,
          backedUp: secret.backedUp,
        }),
      });
      settle([entry.id], { status: "credential", credential });
      return "used";
    } finally {
      entry.busy = false;
    }
  };

  const create = async (entry: Pending): Promise<PasskeyUseResult> => {
    if (entry.input.kind !== "create" || !entry.algorithm) return "gone";
    // Claimed before any await: two saves would leave the page one key and
    // the vault another.
    if (entry.busy) return "refused";
    entry.busy = true;
    const options = entry.input.options;
    try {
      if (await unavailable(entry)) return "gone";
      const verified = await verify(entry, `save a passkey for ${entry.rpId}`);
      if (!stillAsking(entry)) return "gone";
      if (!verified) return "refused";
      const { privateKeyPem, publicKey } = generatePasskeyKey(entry.algorithm);
      const credentialId = randomBytes(16);
      await vault.savePasskey(entry.profileId, {
        rpId: entry.rpId,
        username: options.user.name || options.user.displayName,
        credentialId,
        userHandle: fromBase64Url(options.user.id),
        privateKeyPem,
      });
      onVaultChanged(entry.profileId);
      const credential = registrationResponse({
        rpId: entry.rpId,
        origin: entry.origin,
        challenge: fromBase64Url(options.challenge),
        credentialId,
        publicKey,
        flags: flagsFor(verified, { eligible: true, backedUp: false }),
        credProps: options.extensions?.credProps === true,
      });
      settle([entry.id], { status: "credential", credential });
      return "used";
    } finally {
      entry.busy = false;
    }
  };

  ipcMain.handle(
    "catamorphic:passkey-begin",
    async (event, raw: unknown): Promise<PasskeyAnswer> => {
      const guest = event.sender;
      const frame = event.senderFrame;
      const parsed = beginInput.safeParse(raw);
      // Only the top frame is wrapped. Its origin, not its URL, is the
      // caller: a sandboxed document keeps its URL but has an opaque
      // ("null") origin, and Work never signs for one.
      if (
        !parsed.success ||
        guest.getType() !== "webview" ||
        !frame ||
        frame.detached ||
        frame.parent !== null
      )
        return { status: "settled" };
      const input = parsed.data;
      const origin = siteOrigin(frame.origin);
      const host = guest.hostWebContents;
      if (!origin || !host || host.isDestroyed()) return { status: "settled" };
      // A tab without focus cannot raise the sheet over the one in front.
      // Chrome refuses an unfocused document at once; Chromium in a
      // webview would leave it waiting, so Work refuses it the same way.
      if (input.mediation === "modal" && !input.focused)
        return { status: "error", name: "NotAllowedError" };
      // Duplicate ids come only from a page calling the bridge itself.
      if (pending.has(input.id)) return { status: "settled" };
      const hostname = new URL(origin).hostname;
      const rpId = (
        input.kind === "create"
          ? (input.options.rp.id ?? hostname)
          : (input.options.rpId ?? hostname)
      ).toLowerCase();
      // Work answers only relying parties it can vouch for. Anything else
      // (related origins, unusual hosts) is Chromium's to accept or refuse.
      if (!validRelyingParty(origin, rpId)) return { status: "settled" };
      const modal = input.mediation === "modal";
      // A page has one modal request at a time (Chromium refuses a second
      // as already pending), so a tab shows at most one sheet, the first.
      if (
        modal &&
        [...pending.values()].some(
          (entry) => entry.guest === guest && entry.host,
        )
      )
        return { status: "settled" };
      // Autofill keeps the page's latest request; an older one waits on.
      if (!modal)
        for (const entry of pending.values())
          if (entry.guest === guest && !entry.host) settle([entry.id]);
      const params =
        input.kind === "create"
          ? input.options.pubKeyCredParams.length > 0
            ? input.options.pubKeyCredParams
            : [
                { type: "public-key", alg: -7 },
                { type: "public-key", alg: -257 },
              ]
          : [];
      const entry: Pending = {
        id: input.id,
        guest,
        profileId: profileFor(host),
        origin,
        rpId,
        input,
        host: modal ? host : null,
        request: null,
        algorithm:
          params
            .filter((param) => param.type === "public-key")
            .map((param) => param.alg)
            .find(isPasskeyAlgorithm) ?? null,
        resolve: () => {},
        busy: false,
      };
      const answer = new Promise<PasskeyAnswer>((resolve) => {
        entry.resolve = resolve;
      });
      watch(guest);
      pending.set(entry.id, entry);
      if (modal) {
        // A vault that cannot open (no keychain) still shows the sheet, so
        // the request stays answerable by a security key or a cancel.
        const shown = await describeRequest(entry, input.icon).catch(() =>
          describeRequest(entry, input.icon, "vault-unavailable"),
        );
        // The page may have given up while the vault opened.
        if (pending.get(entry.id) === entry) {
          entry.request = shown;
          host.send("catamorphic:passkey-request", shown);
        }
      }
      return answer;
    },
  );

  /** A modal request as the sheet shows it. */
  async function describeRequest(
    entry: Pending,
    icon: string | undefined,
    failed?: "vault-unavailable",
  ): Promise<PasskeyRequest> {
    const input = entry.input;
    const why = failed ?? (await unavailable(entry));
    return {
      id: entry.id,
      guestId: entry.guest.id,
      origin: entry.origin,
      rpId: entry.rpId,
      kind: input.kind,
      // Page-supplied, so only a web address the sheet can load.
      icon: siteOrigin(icon ?? "") ? icon : undefined,
      passkeys: why ? [] : choices(await candidates(entry)),
      account:
        input.kind === "create"
          ? {
              name: input.options.user.name,
              displayName: input.options.user.displayName,
            }
          : undefined,
      unavailable: why,
      verifies: vault.canVerifyUser(),
    };
  }

  // The page finished a request itself: a security key answered, its
  // deadline passed, or it aborted.
  const onSettle = (event: Electron.IpcMainEvent, input: unknown) => {
    const parsed = z.object({ id: z.string() }).safeParse(input);
    if (!parsed.success) return;
    if (pending.get(parsed.data.id)?.guest === event.sender)
      settle([parsed.data.id]);
  };
  ipcMain.on("catamorphic:passkey-settle", onSettle);

  /** A modal request, for the window showing it. */
  const shownTo = (host: WebContents, id: string) => {
    const entry = pending.get(id);
    return entry?.host === host && !entry.guest.isDestroyed() ? entry : null;
  };
  const idInput = z.object({ id: z.string() });
  ipcMain.handle(
    "catamorphic:passkey-cancel",
    (event, input: unknown): boolean => {
      const entry = shownTo(event.sender, idInput.parse(input).id);
      if (!entry) return false;
      // A creation Work refused because the account already has a passkey
      // here ends as the spec's "already registered".
      settle([entry.id], {
        status: "error",
        name:
          entry.request?.unavailable === "excluded"
            ? "InvalidStateError"
            : "NotAllowedError",
      });
      return true;
    },
  );
  ipcMain.handle(
    "catamorphic:passkey-use",
    (event, input: unknown): Promise<PasskeyUseResult> | PasskeyUseResult => {
      const { id, passkeyId } = idInput
        .extend({ passkeyId: z.string() })
        .parse(input);
      const entry = shownTo(event.sender, id);
      return entry ? signIn(entry, passkeyId) : "gone";
    },
  );
  ipcMain.handle(
    "catamorphic:passkey-save",
    (event, input: unknown): Promise<PasskeyUseResult> | PasskeyUseResult => {
      const entry = shownTo(event.sender, idInput.parse(input).id);
      return entry ? create(entry) : "gone";
    },
  );

  /** The autofill request waiting in a tab the calling window shows. */
  const autofillFor = (host: WebContents, guestId: number) => {
    const guest = webContents.fromId(guestId);
    if (!guest || guest.isDestroyed() || guest.hostWebContents !== host)
      return null;
    return (
      [...pending.values()].find(
        (entry) => entry.guest === guest && !entry.host,
      ) ?? null
    );
  };
  const guestInput = z.object({ guestId: z.number().int() });
  ipcMain.handle(
    "catamorphic:passkey-autofill",
    async (
      event,
      input: unknown,
    ): Promise<{ requestId: string; passkeys: PasskeyChoice[] } | null> => {
      const entry = autofillFor(event.sender, guestInput.parse(input).guestId);
      if (!entry || (await unavailable(entry))) return null;
      return {
        requestId: entry.id,
        passkeys: choices(await candidates(entry)),
      };
    },
  );
  ipcMain.handle(
    "catamorphic:passkey-autofill-use",
    (event, input: unknown): Promise<PasskeyUseResult> | PasskeyUseResult => {
      const { guestId, requestId, passkeyId } = guestInput
        .extend({ requestId: z.string(), passkeyId: z.string() })
        .parse(input);
      const entry = autofillFor(event.sender, guestId);
      return entry?.id === requestId ? signIn(entry, passkeyId) : "gone";
    },
  );
  ipcMain.handle("catamorphic:passkey-capabilities", () => ({
    verifies: vault.canVerifyUser(),
  }));

  return () => {
    ipcMain.removeHandler("catamorphic:passkey-begin");
    ipcMain.removeListener("catamorphic:passkey-settle", onSettle);
    ipcMain.removeHandler("catamorphic:passkey-cancel");
    ipcMain.removeHandler("catamorphic:passkey-use");
    ipcMain.removeHandler("catamorphic:passkey-save");
    ipcMain.removeHandler("catamorphic:passkey-autofill");
    ipcMain.removeHandler("catamorphic:passkey-autofill-use");
    ipcMain.removeHandler("catamorphic:passkey-capabilities");
    settle([...pending.keys()]);
  };
}
