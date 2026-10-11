import { contextBridge, ipcRenderer } from "electron";
import {
  PASSKEY_TIMEOUT_DEFAULT_MS,
  PASSKEY_TIMEOUT_MAX_MS,
  PASSKEY_TIMEOUT_MIN_MS,
  type PasskeyAnswer,
  type PasskeyMediation,
  type PasskeyRequestKind,
} from "../shared/passkeys.js";

/** The icon the tab shows: the page's last icon link for this theme. */
function pageIcon(): string | undefined {
  const links = [
    ...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon" i]'),
  ].filter((link) => !link.media || matchMedia(link.media).matches);
  return links.at(-1)?.href || undefined;
}
/**
 * Passkeys (Web Authentication, see shared/passkeys.ts), for a page in a
 * tab or in a sign-in popup it opened. Electron gives a request no UI, no
 * timer and nowhere to keep a passkey. Each modal request here goes to
 * main, which shows it in the passkey sheet over the page and answers
 * with a passkey from the profile's vault when the person picks one (or
 * saves a new one). Chromium runs the same request alongside, so a
 * security key can still answer, and the request keeps Chrome's
 * deadline. Autofill requests wait in main until the person picks a
 * passkey under a field. Only the top frame is wrapped.
 */
export function installPasskeys(): void {
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
            if (options.mediation === "conditional")
              return conditional(options);
            return run("get", nativeGet, this, options);
          },
          configurable: true,
          writable: true,
        });
        Object.defineProperty(container, "create", {
          value: function create(
            this: CredentialsContainer,
            options?: Options,
          ) {
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
}
