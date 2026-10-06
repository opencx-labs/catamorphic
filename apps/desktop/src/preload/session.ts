import { contextBridge, ipcRenderer } from "electron";
import {
  EXTENSION_CHANNELS,
  type ExtensionCallAnswer,
} from "../shared/extension-channels.js";
import { alignClientHintBrands } from "./client-hints.js";
import {
  type ExtensionBoot,
  type ExtensionHostBridge,
  installExtensionApis,
} from "./extension-api.js";
import { installWebStoreApis, type WebStoreBridge } from "./webstore-api.js";

/**
 * A browsing session's preload, registered for every frame and service
 * worker of a profile's browsing session (ADR 0203). It must stay one
 * self-contained file: sandboxed renderers cannot load chunks.
 *  - Every page and worker presents Chrome's client-hint brands.
 *  - An extension's service worker or page gets Work's `chrome.*` APIs
 *    (extension-api.ts) before its own code runs; a popup closes on Escape
 *    or when focus leaves it.
 *  - The Chrome Web Store page gets `chrome.webstorePrivate`, so its "Add
 *    to Chrome" button asks Work to install.
 * Web pages see nothing else; main checks each caller again.
 */

const WEB_STORE_ORIGIN = "https://chromewebstore.google.com";

function stripInvokeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""),
  );
}

function bridge(): ExtensionHostBridge {
  const sendChannels: Record<string, string> = {
    listen: EXTENSION_CHANNELS.listen,
    "native-connect": EXTENSION_CHANNELS.nativeConnect,
    "native-post": EXTENSION_CHANNELS.nativePost,
    "native-disconnect": EXTENSION_CHANNELS.nativeDisconnect,
  };
  return {
    call: async (method, args) => {
      // Read here, in the preload's world: the extension's code can patch
      // its own navigator, never this one.
      const gesture =
        typeof navigator !== "undefined" &&
        navigator.userActivation?.isActive === true;
      const answer: ExtensionCallAnswer = await ipcRenderer.invoke(
        EXTENSION_CHANNELS.call,
        method,
        args,
        { gesture },
      );
      if ("error" in answer) throw new Error(answer.error);
      return answer.result;
    },
    send: (channel, args) => {
      const target = sendChannels[channel];
      if (target) ipcRenderer.send(target, ...args);
    },
    onEvent: (listener) => {
      ipcRenderer.on(EXTENSION_CHANNELS.event, (_event, name, args) =>
        listener(String(name), Array.isArray(args) ? args : []),
      );
    },
    // Synchronous on purpose: main's answer (rulesets to enable, granted
    // permissions) must apply before the extension's own code runs.
    isView: (tabId) => {
      try {
        return ipcRenderer.sendSync(EXTENSION_CHANNELS.isView, tabId) === true;
      } catch {
        return false;
      }
    },
    boot: () => {
      try {
        const boot: unknown = ipcRenderer.sendSync(EXTENSION_CHANNELS.boot);
        return boot && typeof boot === "object"
          ? (boot as ExtensionBoot)
          : null;
      } catch {
        return null;
      }
    },
  };
}

function installForExtension(): void {
  contextBridge.exposeInMainWorld("__workExtensionHost", bridge());
  contextBridge.executeInMainWorld({ func: installExtensionApis });
}

/** A popup closes like Chrome's: Escape, or focus going elsewhere. */
function watchPopupMode(): void {
  ipcRenderer.once(EXTENSION_CHANNELS.popupMode, () => {
    const close = () => ipcRenderer.sendToHost(EXTENSION_CHANNELS.popupClose);
    // Escape reached the page beside it (main/extensions/host.ts).
    ipcRenderer.on(EXTENSION_CHANNELS.popupClose, close);
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && !event.defaultPrevented) close();
      },
      true,
    );
    window.addEventListener("blur", () => {
      // A focused iframe inside the popup is still the popup.
      setTimeout(() => {
        if (!document.hasFocus()) close();
      }, 0);
    });
  });
}

function webStoreOrigin(): string {
  const env = process.env;
  return (
    (env.CATAMORPHIC_E2E_DATA_DIR && env.CATAMORPHIC_E2E_WEBSTORE_ORIGIN) ||
    WEB_STORE_ORIGIN
  );
}

function installForWebStore(): void {
  const store: WebStoreBridge = {
    call: (method, args) =>
      ipcRenderer
        .invoke(EXTENSION_CHANNELS.webstore, method, args, {
          // The page's own activation, read where its scripts can't fake it.
          gesture: navigator.userActivation?.isActive === true,
        })
        .catch((error: unknown) => {
          throw stripInvokeError(error);
        }),
    onEvent: (listener) => {
      ipcRenderer.on(EXTENSION_CHANNELS.webstoreEvent, (_event, name, args) =>
        listener(String(name), Array.isArray(args) ? args : []),
      );
    },
  };
  contextBridge.exposeInMainWorld("__workWebStore", store);
  contextBridge.executeInMainWorld({ func: installWebStoreApis });
}

/**
 * A press in a page closes the window's extension popup, as Chrome's
 * closes when it loses focus: a window's guests share its focus, and a
 * loading page can hold on to it. Registered before the page's own
 * scripts, so they can't stop it.
 */
function reportPresses(): void {
  window.addEventListener(
    "pointerdown",
    () => ipcRenderer.send(EXTENSION_CHANNELS.pagePressed),
    { capture: true },
  );
}

/** One job failing (an unusual context) must not stop the others. */
function attempt(job: () => void): void {
  try {
    job();
  } catch (error) {
    console.error("[work] browsing session preload:", error);
  }
}

attempt(alignClientHintBrands);
if (process.type === "service-worker") {
  attempt(installForExtension);
} else {
  attempt(reportPresses);
  if (location.protocol === "chrome-extension:") {
    attempt(installForExtension);
    if (window.top === window) attempt(watchPopupMode);
  } else if (location.origin === webStoreOrigin() && window.top === window) {
    attempt(installForWebStore);
  }
}
