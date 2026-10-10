import { contextBridge, ipcRenderer, webFrame } from "electron";
import { matchesShortcut } from "../shared/keybindings.js";
import {
  classifyPasswordField,
  type FieldDescriptor,
  isStandaloneUsername,
  isUsernameCandidate,
} from "../shared/login-fields.js";
import { openModeFromEvent } from "../shared/open-mode.js";
import {
  PASSKEY_TIMEOUT_DEFAULT_MS,
  PASSKEY_TIMEOUT_MAX_MS,
  PASSKEY_TIMEOUT_MIN_MS,
  type PasskeyAnswer,
  type PasskeyMediation,
  type PasskeyRequestKind,
} from "../shared/passkeys.js";

/**
 * Guest preload for browser-tab webviews. Runs inside untrusted pages with
 * context isolation. Credential secrets travel directly between this guest
 * and the trusted main process; the embedding renderer receives metadata
 * and status only. (Chrome's client-hint brands come from the browsing
 * session's preload, session.ts.) Jobs, all Chrome-like:
 *  - place password suggestions under login fields and report submitted
 *    logins (offer-to-save, auto-save of generated passwords),
 *  - fill saved or generated passwords on command,
 *  - answer passkey requests from the profile's vault, keeping a security
 *    key, a deadline and a cancel.
 */

/**
 * Page notifications go through the main process so macOS shows the site
 * under the title, as Chrome does, and so the site's own notification
 * permission (site settings) is what decides. The page keeps the standard
 * `Notification` surface: permission reads the site's real state
 * (default / granted / denied), requestPermission prompts through the
 * browser, and click/show/close events reach the page. Service-worker
 * notifications are outside this path.
 */
type NotificationPermissionState = "default" | "granted" | "denied";
interface GuestNotificationEvent {
  id: number;
  type: "show" | "click" | "close" | "error";
}
const notificationListeners = new Set<
  (event: GuestNotificationEvent) => void
>();
ipcRenderer.on(
  "catamorphic:guest-notification-event",
  (_event, payload: GuestNotificationEvent) => {
    for (const listener of notificationListeners) listener(payload);
  },
);
contextBridge.exposeInMainWorld("__workNotifications", {
  permission: (): NotificationPermissionState =>
    ipcRenderer.sendSync("catamorphic:guest-notification-permission"),
  show: (input: {
    title: string;
    body: string;
    tag: string;
    silent: boolean;
  }): Promise<number | null> =>
    ipcRenderer.invoke("catamorphic:guest-notification-show", input),
  close: (id: number): void => {
    ipcRenderer.send("catamorphic:guest-notification-close", id);
  },
  subscribe: (listener: (event: GuestNotificationEvent) => void): void => {
    notificationListeners.add(listener);
  },
});
if (typeof contextBridge.executeInMainWorld === "function") {
  contextBridge.executeInMainWorld({
    func: () => {
      interface Bridge {
        permission: () => NotificationPermissionState;
        show: (input: {
          title: string;
          body: string;
          tag: string;
          silent: boolean;
        }) => Promise<number | null>;
        close: (id: number) => void;
        subscribe: (listener: (event: GuestNotificationEvent) => void) => void;
      }
      const exposed = (window as Window & { __workNotifications?: Bridge })
        .__workNotifications;
      const Native = window.Notification;
      if (!exposed || !Native) return;
      const bridge: Bridge = exposed;
      const registry = new Map<number, WorkNotification>();
      type Handler = ((event: Event) => void) | null;
      class WorkNotification extends EventTarget {
        readonly title: string;
        readonly body: string;
        readonly tag: string;
        readonly icon: string;
        readonly badge = "";
        readonly image = "";
        readonly dir = "auto";
        readonly lang = "";
        readonly data: unknown;
        readonly silent: boolean | null;
        readonly requireInteraction: boolean;
        readonly timestamp = Date.now();
        onclick: Handler = null;
        onshow: Handler = null;
        onclose: Handler = null;
        onerror: Handler = null;
        private id: number | null = null;
        private closed = false;
        constructor(title: string, options: NotificationOptions = {}) {
          super();
          this.title = String(title);
          this.body = options.body ?? "";
          this.tag = options.tag ?? "";
          this.icon = options.icon ?? "";
          this.data = options.data;
          this.silent = options.silent ?? null;
          this.requireInteraction = options.requireInteraction ?? false;
          void bridge
            .show({
              title: this.title,
              body: this.body,
              tag: this.tag,
              silent: this.silent === true,
            })
            .then((id) => {
              if (id === null) {
                this.fire("error");
                return;
              }
              this.id = id;
              registry.set(id, this);
              // Closed before the id arrived: close it now.
              if (this.closed) bridge.close(id);
            });
        }
        fire(type: "show" | "click" | "close" | "error"): void {
          const event = new Event(type);
          this.dispatchEvent(event);
          const handler = this[`on${type}` as const];
          if (typeof handler === "function") handler.call(this, event);
        }
        close(): void {
          this.closed = true;
          if (this.id !== null) bridge.close(this.id);
        }
        static get permission(): NotificationPermissionState {
          return bridge.permission();
        }
        static get maxActions(): number {
          return 0;
        }
        static requestPermission(
          callback?: (permission: NotificationPermissionState) => void,
        ): Promise<NotificationPermissionState> {
          const request = Native.requestPermission().then(() =>
            bridge.permission(),
          );
          if (callback) void request.then(callback);
          return request;
        }
      }
      bridge.subscribe(({ id, type }) => {
        const notification = registry.get(id);
        if (!notification) return;
        notification.fire(type);
        if (type === "close" || type === "error") registry.delete(id);
      });
      Object.defineProperty(window, "Notification", {
        value: WorkNotification,
        configurable: true,
        writable: true,
      });
    },
    args: [],
  });
}

/**
 * Passkeys (Web Authentication, see shared/passkeys.ts). Electron gives a
 * request no UI, no timer and nowhere to keep a passkey. Each modal
 * request here goes to main, which shows it in the window's passkey
 * sheet and answers with a passkey from the profile's vault when the
 * person picks one (or saves a new one). Chromium runs the same request
 * alongside, so a security key can still answer, and the request keeps
 * Chrome's deadline. Autofill requests wait in main until the person
 * picks a passkey under a field. Only the top frame is wrapped.
 */
/** The icon the tab shows: the page's last icon link for this theme. */
function pageIcon(): string | undefined {
  const links = [
    ...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon" i]'),
  ].filter((link) => !link.media || matchMedia(link.media).matches);
  return links.at(-1)?.href || undefined;
}
contextBridge.exposeInMainWorld("__workPasskeys", {
  begin: (
    id: string,
    kind: PasskeyRequestKind,
    mediation: PasskeyMediation,
    options: unknown,
  ): Promise<PasskeyAnswer> =>
    ipcRenderer.invoke("catamorphic:passkey-begin", {
      id,
      kind,
      mediation,
      icon: pageIcon(),
      // Read in this isolated world, where the page cannot redefine it.
      focused: document.hasFocus(),
      options,
    }),
  settle: (id: string): void => {
    ipcRenderer.send("catamorphic:passkey-settle", { id });
  },
  capabilities: (): Promise<{ verifies: boolean }> =>
    ipcRenderer.invoke("catamorphic:passkey-capabilities"),
  /** Whether the page has focus, read where the page cannot redefine it. */
  focused: (): boolean => document.hasFocus(),
});
if (typeof contextBridge.executeInMainWorld === "function") {
  contextBridge.executeInMainWorld({
    func: (defaultMs: number, minMs: number, maxMs: number) => {
      type Answer =
        | { status: "credential"; credential: CredentialJson }
        | { status: "error"; name: string }
        | { status: "settled" };
      interface CredentialJson {
        id: string;
        type: string;
        authenticatorAttachment: string;
        response: {
          clientDataJSON: string;
          authenticatorData: string;
          attestationObject?: string;
          publicKey?: string;
          publicKeyAlgorithm?: number;
          transports?: string[];
          signature?: string;
          userHandle?: string | null;
        };
        clientExtensionResults: Record<string, unknown>;
      }
      interface Bridge {
        begin: (
          id: string,
          kind: "get" | "create",
          mediation: "modal" | "conditional",
          options: unknown,
        ) => Promise<Answer>;
        settle: (id: string) => void;
        capabilities: () => Promise<{ verifies: boolean }>;
        focused: () => boolean;
      }
      type Descriptor = { type?: unknown; id?: unknown };
      type PublicKey = {
        timeout?: unknown;
        challenge?: unknown;
        rpId?: unknown;
        rp?: { id?: unknown; name?: unknown };
        user?: { id?: unknown; name?: unknown; displayName?: unknown };
        pubKeyCredParams?: Array<{ type?: unknown; alg?: unknown }>;
        excludeCredentials?: Descriptor[];
        allowCredentials?: Descriptor[];
        authenticatorSelection?: {
          authenticatorAttachment?: unknown;
          userVerification?: unknown;
        };
        userVerification?: unknown;
        extensions?: { credProps?: unknown };
      };
      type Options = {
        publicKey?: PublicKey;
        mediation?: string;
        signal?: AbortSignal;
      };
      type Call = (
        this: CredentialsContainer,
        options?: Options,
      ) => Promise<Credential | null>;
      const bridge = (window as Window & { __workPasskeys?: Bridge })
        .__workPasskeys;
      const container = window.CredentialsContainer?.prototype;
      if (!bridge || !container) return;
      const nativeGet = container.get as Call;
      const nativeCreate = container.create as Call;
      // Chrome's words for each way a request ends.
      const messages: Record<string, string> = {
        NotAllowedError:
          "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.",
        InvalidStateError:
          "The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.",
        SecurityError:
          "The relying party ID is not a registrable domain suffix of, nor equal to the current domain.",
        NotSupportedError: "The operation is not supported.",
      };
      const failure = (name: string) =>
        new DOMException(messages[name] ?? messages.NotAllowedError, name);
      const notAllowed = () => failure("NotAllowedError");
      const deadline = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value)
          ? Math.min(maxMs, Math.max(minMs, value))
          : defaultMs;

      // --- base64url, as main reads and writes binary ---
      const bytesOf = (source: unknown): Uint8Array => {
        if (source instanceof ArrayBuffer) return new Uint8Array(source);
        if (ArrayBuffer.isView(source))
          return new Uint8Array(
            source.buffer,
            source.byteOffset,
            source.byteLength,
          );
        throw new TypeError("Expected a BufferSource");
      };
      const encode = (source: unknown) => {
        let text = "";
        for (const byte of bytesOf(source)) text += String.fromCharCode(byte);
        return btoa(text)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      };
      const decode = (text: string): ArrayBuffer => {
        const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
        const raw = atob(base64 + "===".slice((base64.length + 3) % 4));
        const bytes = new Uint8Array(raw.length);
        for (let index = 0; index < raw.length; index++)
          bytes[index] = raw.charCodeAt(index);
        return bytes.buffer;
      };
      const text = (value: unknown) =>
        typeof value === "string" ? value : undefined;
      const descriptors = (list: Descriptor[] | undefined) =>
        Array.from(list ?? [], (item) => ({
          type: String(item.type),
          id: encode(item.id),
        }));

      /** The request as main reads it; throws for malformed options. */
      const describe = (
        kind: "get" | "create",
        publicKey: PublicKey,
      ): unknown => {
        if (kind === "get")
          return {
            challenge: encode(publicKey.challenge),
            rpId: text(publicKey.rpId),
            allowCredentials: descriptors(publicKey.allowCredentials),
            userVerification: text(publicKey.userVerification),
          };
        const selection = publicKey.authenticatorSelection;
        return {
          challenge: encode(publicKey.challenge),
          rp: {
            id: text(publicKey.rp?.id),
            name: String(publicKey.rp?.name ?? ""),
          },
          user: {
            id: encode(publicKey.user?.id),
            name: String(publicKey.user?.name ?? ""),
            displayName: String(publicKey.user?.displayName ?? ""),
          },
          pubKeyCredParams: Array.from(
            publicKey.pubKeyCredParams ?? [],
            (param) => ({ type: String(param.type), alg: Number(param.alg) }),
          ),
          excludeCredentials: descriptors(publicKey.excludeCredentials),
          authenticatorSelection: selection
            ? {
                authenticatorAttachment: text(
                  selection.authenticatorAttachment,
                ),
                userVerification: text(selection.userVerification),
              }
            : undefined,
          extensions:
            publicKey.extensions?.credProps === true
              ? { credProps: true }
              : undefined,
        };
      };

      /**
       * A PublicKeyCredential for Work's answer: the platform's own
       * prototypes, so `instanceof` and SDK feature checks hold, with
       * the values as own properties.
       */
      const build = (json: CredentialJson): Credential => {
        const fields = json.response;
        const registering = typeof fields.attestationObject === "string";
        const response = Object.create(
          registering
            ? AuthenticatorAttestationResponse.prototype
            : AuthenticatorAssertionResponse.prototype,
        );
        const values: Record<string, unknown> = {
          clientDataJSON: decode(fields.clientDataJSON),
        };
        if (registering) {
          const transports = fields.transports ?? [];
          Object.assign(values, {
            attestationObject: decode(fields.attestationObject ?? ""),
            getAuthenticatorData: () => decode(fields.authenticatorData),
            getPublicKey: () => decode(fields.publicKey ?? ""),
            getPublicKeyAlgorithm: () => fields.publicKeyAlgorithm,
            getTransports: () => [...transports],
          });
        } else
          Object.assign(values, {
            authenticatorData: decode(fields.authenticatorData),
            signature: decode(fields.signature ?? ""),
            userHandle: fields.userHandle ? decode(fields.userHandle) : null,
          });
        for (const [key, value] of Object.entries(values))
          Object.defineProperty(response, key, {
            value,
            enumerable: true,
            configurable: true,
          });
        const responseJson = registering
          ? {
              clientDataJSON: fields.clientDataJSON,
              authenticatorData: fields.authenticatorData,
              transports: fields.transports ?? [],
              publicKey: fields.publicKey,
              publicKeyAlgorithm: fields.publicKeyAlgorithm,
              attestationObject: fields.attestationObject,
            }
          : {
              clientDataJSON: fields.clientDataJSON,
              authenticatorData: fields.authenticatorData,
              signature: fields.signature,
              ...(fields.userHandle ? { userHandle: fields.userHandle } : {}),
            };
        const credential = Object.create(PublicKeyCredential.prototype);
        const own: Record<string, unknown> = {
          id: json.id,
          rawId: decode(json.id),
          type: json.type,
          authenticatorAttachment: json.authenticatorAttachment,
          response,
          getClientExtensionResults: () => ({
            ...json.clientExtensionResults,
          }),
          toJSON: () => ({
            id: json.id,
            rawId: json.id,
            type: json.type,
            authenticatorAttachment: json.authenticatorAttachment,
            response: { ...responseJson },
            clientExtensionResults: { ...json.clientExtensionResults },
          }),
        };
        for (const [key, value] of Object.entries(own))
          Object.defineProperty(credential, key, {
            value,
            enumerable: true,
            configurable: true,
          });
        return credential;
      };

      const run = (
        kind: "get" | "create",
        native: Call,
        self: CredentialsContainer,
        options: Options,
      ): Promise<Credential | null> => {
        const signal = options.signal;
        if (signal?.aborted) return Promise.reject(signal.reason);
        // Chrome refuses a document without focus at once. Refused here,
        // it never reaches Chromium, whose single request slot (and its
        // abort) belongs to the request that is really waiting.
        if (!bridge.focused()) return Promise.reject(notAllowed());
        let described: unknown = null;
        try {
          described = describe(kind, options.publicKey ?? {});
        } catch {
          // Chromium reports malformed options in its own words.
        }
        const id = crypto.randomUUID();
        const controller = new AbortController();
        return new Promise((resolve, reject) => {
          let done = false;
          // Why the request ended before an answer: the page aborted, the
          // deadline passed or the sheet was cancelled, or Work answered.
          let ended: "page" | "stopped" | "answered" | null = null;
          let nativeFailure: unknown = null;
          let nativeDone = false;
          // Work's sheet is up and may still answer.
          let sheet = described !== null;
          const finish = (settleSheet: boolean, act: () => void) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onPageAbort);
            if (settleSheet) bridge.settle(id);
            act();
          };
          const stopped = (why: "page" | "stopped") =>
            why === "page" ? signal?.reason : notAllowed();
          const stop = (why: "page" | "stopped") => {
            if (ended) return;
            ended = why;
            controller.abort();
            if (nativeDone) finish(true, () => reject(stopped(why)));
          };
          const onPageAbort = () => stop("page");
          signal?.addEventListener("abort", onPageAbort, { once: true });
          const timer = setTimeout(
            () => stop("stopped"),
            deadline(options.publicKey?.timeout),
          );
          if (described !== null)
            bridge.begin(id, kind, "modal", described).then(
              (answer) => {
                if (done || ended) return;
                if (answer.status === "settled") {
                  sheet = false;
                  if (nativeDone) finish(false, () => reject(nativeFailure));
                  return;
                }
                ended = "answered";
                controller.abort();
                finish(false, () =>
                  answer.status === "credential"
                    ? resolve(build(answer.credential))
                    : reject(failure(answer.name)),
                );
              },
              () => {
                // Work could not take the request; Chromium's answer stands.
                sheet = false;
                if (nativeDone && !done && !ended)
                  finish(false, () => reject(nativeFailure));
              },
            );
          // A security key answers through Chromium.
          native.call(self, { ...options, signal: controller.signal }).then(
            (credential) => {
              nativeDone = true;
              finish(true, () => resolve(credential));
            },
            (error: unknown) => {
              nativeDone = true;
              const why = ended;
              if (why === "answered") return;
              if (why) return finish(true, () => reject(stopped(why)));
              // Chromium may give up at once when nothing it knows can
              // answer; the sheet still can.
              if (
                sheet &&
                error instanceof DOMException &&
                error.name === "NotAllowedError"
              ) {
                nativeFailure = error;
                return;
              }
              finish(true, () => reject(error));
            },
          );
        });
      };

      /** Autofill: answered when the person picks a passkey under a field. */
      const conditional = (options: Options): Promise<Credential | null> => {
        const signal = options.signal;
        if (signal?.aborted) return Promise.reject(signal.reason);
        let described: unknown;
        try {
          described = describe("get", options.publicKey ?? {});
        } catch {
          return Promise.reject(new TypeError("Invalid passkey request"));
        }
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          let done = false;
          const onAbort = () => {
            if (done) return;
            done = true;
            bridge.settle(id);
            reject(signal?.reason);
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          bridge.begin(id, "get", "conditional", described).then(
            (answer) => {
              // `settled`: a newer autofill request took over; this one
              // waits for the page's abort, as Chrome's does.
              if (done || answer.status === "settled") return;
              done = true;
              signal?.removeEventListener("abort", onAbort);
              if (answer.status === "credential")
                resolve(build(answer.credential));
              else reject(failure(answer.name));
            },
            () => {},
          );
        });
      };

      Object.defineProperty(container, "get", {
        value: function get(this: CredentialsContainer, options?: Options) {
          if (!options?.publicKey) return nativeGet.call(this, options);
          if (options.mediation === "conditional") return conditional(options);
          return run("get", nativeGet, this, options);
        },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(container, "create", {
        value: function create(this: CredentialsContainer, options?: Options) {
          if (!options?.publicKey) return nativeCreate.call(this, options);
          // Creating a passkey quietly after a password sign-in is not
          // offered; a site asks again with the sheet.
          if (options.mediation === "conditional")
            return Promise.reject(notAllowed());
          return run("create", nativeCreate, this, options);
        },
        configurable: true,
        writable: true,
      });
      const Credential = window.PublicKeyCredential as
        | (typeof PublicKeyCredential & {
            getClientCapabilities?: () => Promise<Record<string, boolean>>;
          })
        | undefined;
      if (!Credential) return;
      const verifies = () =>
        bridge.capabilities().then(
          (found) => found.verifies,
          () => false,
        );
      Object.defineProperty(Credential, "isConditionalMediationAvailable", {
        value: () => Promise.resolve(true),
        configurable: true,
        writable: true,
      });
      Object.defineProperty(
        Credential,
        "isUserVerifyingPlatformAuthenticatorAvailable",
        { value: verifies, configurable: true, writable: true },
      );
      const capabilities = Credential.getClientCapabilities;
      if (typeof capabilities === "function")
        Object.defineProperty(Credential, "getClientCapabilities", {
          value: () =>
            Promise.all([capabilities.call(Credential), verifies()]).then(
              ([found, verified]) => ({
                ...found,
                conditionalCreate: false,
                conditionalGet: true,
                hybridTransport: false,
                passkeyPlatformAuthenticator: true,
                userVerifyingPlatformAuthenticator: verified,
              }),
            ),
          configurable: true,
          writable: true,
        });
    },
    args: [
      PASSKEY_TIMEOUT_DEFAULT_MS,
      PASSKEY_TIMEOUT_MIN_MS,
      PASSKEY_TIMEOUT_MAX_MS,
    ],
  });
}

// The host sees no input inside the page, so it learns of the person's
// presses here: a press in the page is a press outside the floating chat.
// Presses the page's own scripts synthesize are not the person's.
window.addEventListener(
  "pointerdown",
  (event) => {
    if (event.isTrusted) ipcRenderer.sendToHost("catamorphic:page-press");
  },
  { capture: true, passive: true },
);

// Electron's BrowserWindow `app-command` event covers browser mouse buttons
// on Windows/Linux. macOS delivers the auxiliary buttons to the guest page,
// so forward them to the trusted host instead of leaving them inert.
if (process.platform === "darwin") {
  window.addEventListener(
    "mouseup",
    (event) => {
      const direction =
        event.button === 3 ? "back" : event.button === 4 ? "forward" : null;
      if (!direction) return;
      event.preventDefault();
      ipcRenderer.sendToHost("catamorphic:browser-mouse-history", {
        direction,
      });
    },
    { capture: true },
  );
}

/**
 * Two-finger history swipe, as Chrome does it: horizontal trackpad scroll
 * that nothing under the pointer can consume accumulates toward a
 * threshold; crossing it navigates. The host draws the arrow that grows
 * with the gesture. macOS delivers two-finger swipes as wheel events with
 * pixel deltas (three-finger swipes arrive as the window's `swipe` event
 * and are handled by the main process).
 */
const SWIPE_THRESHOLD_PX = 220;
const SWIPE_IDLE_MS = 200;
let swipeSum = 0;
let swipeArmed = true;
let swipeTimer: ReturnType<typeof setTimeout> | undefined;
let swipeShown: "back" | "forward" | null = null;

const reportSwipe = (
  direction: "back" | "forward" | null,
  progress: number,
) => {
  if (direction === null && swipeShown === null) return;
  swipeShown = direction;
  ipcRenderer.sendToHost("catamorphic:browser-swipe", { direction, progress });
};

const resetSwipe = () => {
  clearTimeout(swipeTimer);
  swipeTimer = undefined;
  swipeSum = 0;
  swipeArmed = true;
  reportSwipe(null, 0);
};

/** Can anything from the target up to the document scroll horizontally that way? */
const scrollableToward = (target: EventTarget | null, deltaX: number) => {
  let node = target instanceof Element ? target : null;
  while (node) {
    const style = getComputedStyle(node);
    const overflow = style.overflowX;
    const scrolls =
      node === document.documentElement ||
      node === document.body ||
      overflow === "auto" ||
      overflow === "scroll" ||
      overflow === "overlay";
    if (scrolls && node.scrollWidth > node.clientWidth + 1) {
      if (deltaX < 0 && node.scrollLeft > 0) return true;
      if (
        deltaX > 0 &&
        node.scrollLeft + node.clientWidth < node.scrollWidth - 1
      )
        return true;
    }
    node = node.parentElement;
  }
  return false;
};

window.addEventListener(
  "wheel",
  (event) => {
    if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;
    const { deltaX, deltaY } = event;
    // A vertical scroll, or a mixed one, is not a history gesture.
    if (Math.abs(deltaX) < 2 || Math.abs(deltaX) < Math.abs(deltaY) * 2) {
      if (swipeSum !== 0) resetSwipe();
      return;
    }
    if (scrollableToward(event.target, deltaX)) {
      if (swipeSum !== 0) resetSwipe();
      return;
    }
    clearTimeout(swipeTimer);
    swipeTimer = setTimeout(resetSwipe, SWIPE_IDLE_MS);
    // A change of direction mid-gesture starts over.
    if (swipeSum !== 0 && Math.sign(swipeSum) !== Math.sign(deltaX))
      swipeSum = 0;
    swipeSum += deltaX;
    // Fingers moving right (negative deltaX) pull the previous page in.
    const direction = swipeSum < 0 ? "back" : "forward";
    const progress = Math.min(1, Math.abs(swipeSum) / SWIPE_THRESHOLD_PX);
    if (!swipeArmed) return;
    reportSwipe(direction, progress);
    if (progress >= 1) {
      swipeArmed = false;
      // The navigation replaces this page (and its idle timer): clear the
      // arrow now rather than leaving it to a world that is going away.
      reportSwipe(null, 0);
      ipcRenderer.sendToHost("catamorphic:browser-mouse-history", {
        direction,
      });
    }
  },
  { capture: true, passive: true },
);

/**
 * Passwords. The page tells the host where a login field is when the
 * user clicks it (or tabs into a new-password field), so the host can
 * draw suggestions under it; keys the suggestions own while open come
 * back to the host. Submitted logins go to the trusted main process, and
 * so does every report of the page's password forms, which is how main
 * decides whether a sign-in worked. Secrets arrive only from main, to be
 * written into the fields.
 */
type LoginFieldKind = "username" | "current-password" | "new-password";

interface LoginGroup {
  /** The form, or the document for formless (script-driven) sign-ins. */
  scope: ParentNode;
  username: HTMLInputElement | null;
  passwords: HTMLInputElement[];
}

const fieldIds = new WeakMap<HTMLInputElement, string>();
const fieldsById = new Map<string, WeakRef<HTMLInputElement>>();
let nextFieldId = 1;
function fieldId(input: HTMLInputElement): string {
  let id = fieldIds.get(input);
  if (!id) {
    id = `login-field-${nextFieldId++}`;
    fieldIds.set(input, id);
    fieldsById.set(id, new WeakRef(input));
  }
  return id;
}
function fieldById(id: unknown): HTMLInputElement | null {
  if (typeof id !== "string") return null;
  const input = fieldsById.get(id)?.deref();
  return input?.isConnected ? input : null;
}

function visible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function editable(input: HTMLInputElement): boolean {
  return visible(input) && !input.disabled && !input.readOnly;
}

// "Show password" toggles turn a password field into a text field; it is
// still the password field (and must not read as the form going away).
const passwordFields = new WeakSet<HTMLInputElement>();
function isPasswordField(input: HTMLInputElement): boolean {
  if (input.type === "password") passwordFields.add(input);
  return input.type === "password" || passwordFields.has(input);
}

function describe(input: HTMLInputElement): FieldDescriptor {
  const labels = [...(input.labels ?? [])].map((label) => label.textContent);
  return {
    type: input.type,
    autocomplete: input.getAttribute("autocomplete") ?? "",
    hints: [
      input.name,
      input.id,
      input.placeholder,
      input.getAttribute("aria-label"),
      ...labels,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function formHints(scope: ParentNode): string {
  if (!(scope instanceof HTMLFormElement)) return document.title;
  const submit = scope.querySelector<HTMLElement>(
    'button:not([type="button"]):not([type="reset"]), input[type="submit"]',
  );
  return [
    scope.id,
    scope.getAttribute("action"),
    scope.getAttribute("aria-label"),
    submit?.textContent,
    submit instanceof HTMLInputElement ? submit.value : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function loginGroups(): LoginGroup[] {
  const groups = new Map<ParentNode, HTMLInputElement[]>();
  for (const input of document.querySelectorAll<HTMLInputElement>("input")) {
    if (!isPasswordField(input) || !editable(input)) continue;
    const scope = input.form ?? document;
    groups.set(scope, [...(groups.get(scope) ?? []), input]);
  }
  return [...groups].map(([scope, passwords]) => ({
    scope,
    passwords,
    username: usernameBefore(scope, passwords[0]),
  }));
}

/** The closest account-like field above the first password field. */
function usernameBefore(
  scope: ParentNode,
  password: HTMLInputElement | undefined,
): HTMLInputElement | null {
  if (!password) return null;
  return (
    [...scope.querySelectorAll<HTMLInputElement>("input")]
      .filter(
        (input) =>
          !isPasswordField(input) &&
          editable(input) &&
          input.compareDocumentPosition(password) &
            Node.DOCUMENT_POSITION_FOLLOWING &&
          isUsernameCandidate(describe(input)),
      )
      .at(-1) ?? null
  );
}

function kindOf(input: HTMLInputElement): LoginFieldKind | null {
  if (!editable(input)) return null;
  const group = loginGroups().find(
    (candidate) =>
      candidate.passwords.includes(input) || candidate.username === input,
  );
  if (group) {
    if (group.username === input) return "username";
    return classifyPasswordField({
      field: describe(input),
      index: group.passwords.indexOf(input),
      count: group.passwords.length,
      formHints: formHints(group.scope),
    });
  }
  return !isPasswordField(input) && isStandaloneUsername(describe(input))
    ? "username"
    : null;
}

// --- suggestions under a field ---
let shownField: HTMLInputElement | null = null;
let suggestionsOpen = false;
/** Enter picks a row only while one is highlighted; otherwise it submits. */
let suggestionHighlighted = false;
/** Where a context-menu fill lands when no field id comes with it. */
let lastFocusedField: HTMLInputElement | null = null;

/** A field whose site offers passkeys in autofill (`autocomplete` "webauthn"). */
function wantsPasskeys(input: HTMLInputElement): boolean {
  return /(^|\s)webauthn(\s|$)/i.test(input.getAttribute("autocomplete") ?? "");
}

function showSuggestions(input: HTMLInputElement): void {
  const webauthn = wantsPasskeys(input) && editable(input);
  const kind = kindOf(input) ?? (webauthn ? "username" : null);
  if (!kind) return;
  shownField = input;
  const rect = input.getBoundingClientRect();
  ipcRenderer.sendToHost("catamorphic:autofill-show", {
    fieldId: fieldId(input),
    kind,
    webauthn,
    value: input.value,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  });
}
function hideSuggestions(reason: "blur" | "other" = "other"): void {
  if (!shownField) return;
  shownField = null;
  // A press on the list itself blurs the page first; the host knows
  // whether that is what happened.
  ipcRenderer.sendToHost("catamorphic:autofill-hide", { reason });
}

window.addEventListener(
  "click",
  (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && event.isTrusted)
      showSuggestions(input);
  },
  { capture: true },
);
// Chrome offers a generated password as soon as a new-password field
// takes focus; sign-in suggestions wait for a click or ArrowDown.
window.addEventListener(
  "focusin",
  (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    lastFocusedField = input;
    if (kindOf(input) === "new-password" && !input.value)
      showSuggestions(input);
  },
  { capture: true },
);
window.addEventListener(
  "focusout",
  (event) => {
    if (event.target === shownField) hideSuggestions("blur");
  },
  { capture: true },
);
window.addEventListener(
  "input",
  (event) => {
    if (event.target !== shownField || !shownField) return;
    ipcRenderer.sendToHost("catamorphic:autofill-input", {
      fieldId: fieldId(shownField),
      value: shownField.value,
    });
  },
  { capture: true },
);
window.addEventListener("scroll", () => hideSuggestions(), {
  capture: true,
  passive: true,
});
window.addEventListener("resize", () => hideSuggestions());
ipcRenderer.on("catamorphic:autofill-open", (_event, state: unknown) => {
  const { open, highlighted } =
    state && typeof state === "object"
      ? (state as { open?: unknown; highlighted?: unknown })
      : {};
  suggestionsOpen = open === true;
  suggestionHighlighted = highlighted === true;
});
const SUGGESTION_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Escape"]);
window.addEventListener(
  "keydown",
  (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (suggestionsOpen && input === shownField) {
      if (event.key === "Tab") {
        hideSuggestions();
        return;
      }
      const owned =
        SUGGESTION_KEYS.has(event.key) &&
        !event.isComposing &&
        (event.key !== "Enter" || suggestionHighlighted);
      if (owned) {
        event.preventDefault();
        event.stopImmediatePropagation();
        ipcRenderer.sendToHost("catamorphic:autofill-key", { key: event.key });
        return;
      }
    }
    if (event.key === "ArrowDown" && !event.altKey && !event.metaKey) {
      if (kindOf(input) || wantsPasskeys(input)) {
        event.preventDefault();
        showSuggestions(input);
      }
      return;
    }
    // Enter in a login field submits it, often without a submit event.
    if (event.key === "Enter") {
      hideSuggestions();
      captureSubmission(input);
    }
  },
  { capture: true },
);

// --- form reports: main decides from these whether a sign-in worked ---
let reportedPasswordForms = -1;
function reportForms(load: boolean): void {
  const passwordForms = loginGroups().length;
  if (!load && passwordForms === reportedPasswordForms) return;
  reportedPasswordForms = passwordForms;
  ipcRenderer.send("catamorphic:browser-login-forms", {
    origin: location.origin,
    passwordForms,
    load,
  });
}

// Ignore unrelated SPA churn. A ticking clock, chat stream, or video UI
// should not keep scanning the whole document and sending duplicate IPC.
let observeDebounce: ReturnType<typeof setTimeout> | undefined;
const observer = new MutationObserver((mutations) => {
  const touchesForm = mutations.some(
    (mutation) =>
      mutation.type === "attributes" ||
      [...mutation.addedNodes, ...mutation.removedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches("input, form") || node.querySelector("input, form")),
      ),
  );
  if (!touchesForm || observeDebounce !== undefined) return;
  observeDebounce = setTimeout(() => {
    observeDebounce = undefined;
    if (shownField && !editable(shownField)) hideSuggestions();
    reportForms(false);
  }, 300);
});
const observeForms = () =>
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["type", "autocomplete", "style", "class", "hidden"],
  });

window.addEventListener("DOMContentLoaded", () => {
  reportForms(true);
  observeForms();
});
window.addEventListener("pagehide", () => {
  hideSuggestions();
  observer.disconnect();
  clearTimeout(observeDebounce);
  observeDebounce = undefined;
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  reportForms(true);
  observeForms();
});

// --- submissions ---
/**
 * Report what a sign-in submitted. `from` is the element that submitted
 * (a form, a button, a field): its group is the one that counts, and a
 * formless page takes whichever group holds a password.
 */
function captureSubmission(from: Element): void {
  const form =
    from instanceof HTMLFormElement
      ? from
      : ((from as HTMLInputElement | HTMLButtonElement).form ??
        from.closest("form"));
  const groups = loginGroups();
  const group =
    groups.find((candidate) => candidate.scope === (form ?? document)) ??
    (form
      ? undefined
      : groups.find((candidate) =>
          candidate.passwords.some((input) => input.value),
        ));
  if (group) {
    const newPasswords = group.passwords.filter(
      (input, index) =>
        classifyPasswordField({
          field: describe(input),
          index,
          count: group.passwords.length,
          formHints: formHints(group.scope),
        }) === "new-password",
    );
    // A change form submits the new password; a sign-in its only one.
    const password =
      newPasswords.find((input) => input.value)?.value ??
      group.passwords.find((input) => input.value)?.value ??
      "";
    if (!password) return;
    ipcRenderer.send("catamorphic:browser-credentials-submitted", {
      origin: location.origin,
      username: group.username?.value.trim() ?? "",
      password,
    });
    return;
  }
  // An email-first step: remember who is signing in for the next step.
  const scope: ParentNode = form ?? document;
  const username = [...scope.querySelectorAll<HTMLInputElement>("input")].find(
    (input) =>
      editable(input) && input.value && isStandaloneUsername(describe(input)),
  );
  if (username)
    ipcRenderer.send("catamorphic:browser-username-submitted", {
      origin: location.origin,
      username: username.value.trim(),
    });
}

// Capture phase on the window sees submissions even when the page
// cancels the event later.
window.addEventListener(
  "submit",
  (event) => {
    if (event.target instanceof HTMLFormElement)
      captureSubmission(event.target);
  },
  { capture: true },
);
// Many SPAs sign in from a plain button (or a div) click.
window.addEventListener(
  "click",
  (event) => {
    const target = event.target as Element | null;
    const button = target?.closest?.(
      'button, input[type="submit"], input[type="button"], [role="button"]',
    );
    if (button && event.isTrusted) captureSubmission(button);
  },
  { capture: true },
);

// --- filling ---

function setNativeValue(input: HTMLInputElement, value: string): void {
  // React and friends ignore direct .value writes; go through the native
  // setter and fire input events so frameworks see the change.
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The login group around a field (or the page's first, lacking one). */
function groupFor(input: HTMLInputElement | null): LoginGroup | null {
  const groups = loginGroups();
  return (
    groups.find(
      (group) =>
        !!input &&
        (group.passwords.includes(input) ||
          group.username === input ||
          group.scope === (input.form ?? document)),
    ) ??
    groups[0] ??
    null
  );
}

ipcRenderer.on(
  "catamorphic:fill-credentials",
  (
    _event,
    payload: { fieldId?: string; username: string; password: string },
  ) => {
    const field = fieldById(payload.fieldId) ?? lastFocusedField;
    const group = groupFor(field);
    if (!group) {
      // An email-first step has only the username field.
      if (field && kindOf(field) === "username" && payload.username) {
        setNativeValue(field, payload.username);
        field.focus();
      }
      return;
    }
    if (group.username && payload.username)
      setNativeValue(group.username, payload.username);
    const password = group.passwords[0];
    if (password) {
      setNativeValue(password, payload.password);
      password.focus();
    }
    hideSuggestions();
  },
);

ipcRenderer.on(
  "catamorphic:fill-generated",
  (_event, payload: { fieldId?: string; password: string }) => {
    const field = fieldById(payload.fieldId) ?? lastFocusedField;
    const group = groupFor(field);
    if (!group) return;
    // The new password and its confirmation; never a change form's
    // current password.
    const targets = group.passwords.filter(
      (input, index) =>
        classifyPasswordField({
          field: describe(input),
          index,
          count: group.passwords.length,
          formHints: formHints(group.scope),
        }) === "new-password",
    );
    for (const input of targets.length ? targets : group.passwords)
      setNativeValue(input, payload.password);
    hideSuggestions();
    (field ?? targets[0])?.focus();
  },
);

// Option-click previews are intercepted in the isolated guest preload. Only
// web navigations are relayed; page code never receives desktop IPC access.
let previewLinksEnabled = true;
ipcRenderer.on(
  "catamorphic:preview-links-enabled",
  (_event, enabled: unknown) => {
    previewLinksEnabled = enabled === true;
  },
);
document.addEventListener(
  "click",
  (event) => {
    const mode = openModeFromEvent(event);
    if (
      event.button !== 0 ||
      mode === "replace" ||
      (mode === "floating" && !previewLinksEnabled)
    )
      return;
    const anchor =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      anchor.hasAttribute("download") ||
      !/^https?:\/\//i.test(anchor.href)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.sendToHost("catamorphic:open-link", { url: anchor.href, mode });
  },
  { capture: true },
);

// Scope Escape to floating previews; normal page and terminal shortcuts stay local.
let floatingPreview = "";
ipcRenderer.on("catamorphic:floating-preview", (_event, enabled: unknown) => {
  floatingPreview = typeof enabled === "string" ? enabled : "";
});
window.addEventListener("keydown", (event) => {
  if (
    !floatingPreview ||
    !matchesShortcut({
      event,
      binding: floatingPreview,
      mac: /Mac/.test(navigator.platform),
    }) ||
    event.defaultPrevented
  )
    return;
  event.preventDefault();
  ipcRenderer.sendToHost("catamorphic:dismiss-floating");
});

// Push to talk's keys, while voice is set to it (voice, ADR 0215): the
// main process hears them go down and up; the page never gets them, so a
// held Option+Space types nothing.
let pushToTalkKeys = "";
ipcRenderer.on("catamorphic:push-to-talk-keys", (_event, keys: unknown) => {
  pushToTalkKeys = typeof keys === "string" ? keys : "";
});
window.addEventListener(
  "keydown",
  (event) => {
    if (
      !pushToTalkKeys ||
      !matchesShortcut({
        event,
        binding: pushToTalkKeys,
        mac: /Mac/.test(navigator.platform),
      })
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  { capture: true },
);

// Find keys reach the page first, as in Chrome: a page with its own find
// (a document editor) keeps them; otherwise the tab's find bar takes them.
// This preload runs in the main frame only: a key pressed inside an
// embedded frame stays the page's.
let findKeys: [action: string, binding: string][] = [];
ipcRenderer.on("catamorphic:find-keys", (_event, keys: unknown) => {
  findKeys =
    keys && typeof keys === "object"
      ? Object.entries(keys).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && entry[1] !== "",
        )
      : [];
});
// Captured, so a page that stops the key's propagation without claiming
// it (no preventDefault) still leaves it to the find bar, as in Chrome.
window.addEventListener(
  "keydown",
  (event) => {
    const mac = /Mac/.test(navigator.platform);
    const action = findKeys.find(([, binding]) =>
      matchesShortcut({ event, binding, mac }),
    )?.[0];
    if (!action) return;
    // Read once every listener has had the key, the page's own included.
    setTimeout(() => {
      if (!event.defaultPrevented)
        ipcRenderer.sendToHost("catamorphic:find-key", action);
    });
  },
  { capture: true },
);

// The theme's selection and find-match colors (renderer/lib/page-theme.ts).
// An author stylesheet: Chromium paints highlights from author styles only
// (a user sheet shows in getComputedStyle but never paints). Injected
// sheets come before the page's own, so the page's rules still win.
let pageThemeKey: string | null = null;
ipcRenderer.on("catamorphic:page-theme", (_event, css: unknown) => {
  if (typeof css !== "string") return;
  if (pageThemeKey) webFrame.removeInsertedCSS(pageThemeKey);
  pageThemeKey = css ? webFrame.insertCSS(css) : null;
});

/**
 * Sleeping tabs (ADR 0194): text typed into a field and not yet sent keeps
 * the page awake, as in Chrome. A field's text is remembered as it was
 * before the person first typed into it (React and similar libraries keep
 * `defaultValue` equal to the current value, so it cannot tell); main's
 * probe asks whether any field holds other text now. Sending its form,
 * emptying a composer or removing the field ends that. Search boxes do not
 * count: a query stays in the box after it ran.
 */
type TypedField = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
const typedFields = new Set<WeakRef<TypedField>>();
let typedFrom = new WeakMap<TypedField, string>();
const TEXT_INPUT_TYPES = new Set([
  "text",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);
const SEARCH_ROLES = new Set(["searchbox", "combobox"]);
const fieldText = (field: TypedField) =>
  field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
    ? field.value
    : (field.textContent ?? "");
const typedField = (target: EventTarget | undefined): TypedField | null => {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement)
    return TEXT_INPUT_TYPES.has(target.type) &&
      !SEARCH_ROLES.has(target.getAttribute("role") ?? "")
      ? target
      : null;
  return target instanceof HTMLElement && target.isContentEditable
    ? target
    : null;
};
window.addEventListener(
  "beforeinput",
  (event) => {
    if (!event.isTrusted) return;
    const field = typedField(event.composedPath()[0]);
    if (!field || typedFrom.has(field)) return;
    typedFrom.set(field, fieldText(field));
    typedFields.add(new WeakRef(field));
  },
  true,
);
window.addEventListener(
  "submit",
  (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    for (const ref of typedFields) {
      const field = ref.deref();
      if (field && form.contains(field)) {
        typedFields.delete(ref);
        typedFrom.delete(field);
      }
    }
  },
  true,
);
// A new document in the same page (history navigation keeps the preload).
window.addEventListener("pagehide", () => {
  typedFields.clear();
  typedFrom = new WeakMap();
});
const holdsTypedText = (): boolean => {
  for (const ref of typedFields) {
    const field = ref.deref();
    if (!field?.isConnected) {
      typedFields.delete(ref);
      if (field) typedFrom.delete(field);
      continue;
    }
    const text = fieldText(field);
    if (text.trim() !== "" && text !== typedFrom.get(field)) return true;
  }
  return false;
};
ipcRenderer.on("catamorphic:browser-sleep-probe", (_event, probe: unknown) => {
  ipcRenderer.send("catamorphic:browser-sleep-probe", {
    probe,
    typing: holdsTypedText(),
  });
});
