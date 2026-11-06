/**
 * Channel names between a browsing session's preload and main (ADR 0203).
 * Dependency free: the sandboxed preload bundles it whole.
 */

/**
 * IPC between extension contexts (via the session preload) and main. The
 * caller is always named by the IPC sender, never by these payloads.
 */
export const EXTENSION_CHANNELS = {
  call: "catamorphic:extension-call",
  boot: "catamorphic:extension-boot",
  /** Synchronous: is this "tab" one of Work's popups or side panels? */
  isView: "catamorphic:extension-is-view",
  event: "catamorphic:extension-event",
  listen: "catamorphic:extension-listen",
  nativeConnect: "catamorphic:extension-native-connect",
  nativePost: "catamorphic:extension-native-post",
  nativeDisconnect: "catamorphic:extension-native-disconnect",
  /** Renderer → a popup view: close on Escape or when focus leaves. */
  popupMode: "catamorphic:extension-popup-mode",
  /** A popup view → its renderer (sendToHost); main → a popup to close. */
  popupClose: "catamorphic:extension-popup-close",
  /** A page (any frame of a tab or side panel) → main: the person pressed in it. */
  pagePressed: "catamorphic:extension-page-pressed",
  /** The Chrome Web Store page → main. */
  webstore: "catamorphic:extension-webstore",
  /** Main → the Chrome Web Store page. */
  webstoreEvent: "catamorphic:extension-webstore-event",
} as const;

/**
 * An extension call's answer. A refusal comes back as data, as Chrome puts
 * it in `runtime.lastError`; thrown, Electron would also print it in
 * main's log on every call.
 */
export type ExtensionCallAnswer = { result: unknown } | { error: string };

/** The store page's `chrome.webstorePrivate` / `chrome.management` calls. */
export const WEBSTORE_METHODS = [
  "beginInstallWithManifest3",
  "completeInstall",
  "install",
  "getExtensionStatus",
  "getFullChromeVersion",
  "getMV2DeprecationStatus",
  "getBrowserLogin",
  "getStoreLogin",
  "setStoreLogin",
  "isInIncognitoMode",
  "getIsLauncherEnabled",
  "enableAppLauncher",
  "isPendingCustodianApproval",
  "shouldShowEnterprisePromotionBanner",
  "getReferrerChain",
  "getWebGLStatus",
  "management.getAll",
  "management.get",
  "management.setEnabled",
  "management.uninstall",
] as const;
export type WebStoreMethod = (typeof WEBSTORE_METHODS)[number];
