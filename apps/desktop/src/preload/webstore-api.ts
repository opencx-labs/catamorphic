/**
 * `chrome.webstorePrivate` and `chrome.management` for the Chrome Web Store
 * page (ADR 0203), so its "Add to Chrome" and "Remove from Chrome" buttons
 * reach Work. Serialized into the page's main world by `executeInMainWorld`,
 * so it may not close over anything outside its body. Main shows Work's own
 * dialog before anything installs or goes away; the page only asks.
 */

export interface WebStoreBridge {
  call: (method: string, args: unknown[]) => Promise<unknown>;
  onEvent: (listener: (name: string, args: unknown[]) => void) => void;
}

export function installWebStoreApis(): void {
  type Bag = Record<string, unknown>;
  type Fn = (...args: unknown[]) => unknown;
  const scope = globalThis as unknown as Bag;
  const store = scope.__workWebStore as WebStoreBridge | undefined;
  delete scope.__workWebStore;
  if (!store) return;
  if (!scope.chrome || typeof scope.chrome !== "object") scope.chrome = {};
  const chrome = scope.chrome as Bag;
  if (!chrome.runtime || typeof chrome.runtime !== "object")
    chrome.runtime = {};
  const runtime = chrome.runtime as Bag;

  if (!chrome.extension || typeof chrome.extension !== "object")
    chrome.extension = {};
  const extension = chrome.extension as Bag;
  const lastError = (message: string | null, run: () => void) => {
    const value = message ? { message } : undefined;
    for (const target of [runtime, extension]) {
      try {
        Object.defineProperty(target, "lastError", {
          configurable: true,
          enumerable: true,
          get: () => value,
        });
      } catch {
        // keep the page's own
      }
    }
    try {
      run();
    } finally {
      delete runtime.lastError;
      delete extension.lastError;
    }
  };

  /** Callback or promise, the way the store calls Chrome. */
  const method =
    (name: string): Fn =>
    (...input: unknown[]) => {
      const callback =
        typeof input[input.length - 1] === "function"
          ? (input.pop() as Fn)
          : null;
      const args = JSON.parse(JSON.stringify(input ?? [])) as unknown[];
      // Main answers every call as { result, error? }.
      const result = store.call(name, args).then((envelope) => {
        const outcome = (envelope ?? {}) as {
          result?: unknown;
          error?: unknown;
        };
        return {
          value: outcome.result,
          error: typeof outcome.error === "string" ? outcome.error : null,
        };
      });
      if (callback) {
        result.then(
          ({ value, error }) => lastError(error, () => callback(value)),
          (error: unknown) =>
            lastError(
              error instanceof Error ? error.message : String(error),
              () => callback(),
            ),
        );
        return undefined;
      }
      return result.then(({ value, error }) => {
        if (error && value === undefined) throw new Error(error);
        return value;
      });
    };

  const listeners = new Map<string, Set<Fn>>();
  const event = (name: string) => {
    const set = new Set<Fn>();
    listeners.set(name, set);
    return {
      addListener: (listener: Fn) => void set.add(listener),
      removeListener: (listener: Fn) => void set.delete(listener),
      hasListener: (listener: Fn) => set.has(listener),
    };
  };
  store.onEvent((name, args) => {
    for (const listener of [...(listeners.get(name) ?? [])]) {
      try {
        listener(...args);
      } catch (error) {
        console.error(error);
      }
    }
  });

  const enumOf = (values: Record<string, string>) => Object.freeze(values);
  chrome.webstorePrivate = {
    beginInstallWithManifest3: method("beginInstallWithManifest3"),
    completeInstall: method("completeInstall"),
    install: method("install"),
    getExtensionStatus: method("getExtensionStatus"),
    getFullChromeVersion: method("getFullChromeVersion"),
    getMV2DeprecationStatus: method("getMV2DeprecationStatus"),
    getBrowserLogin: method("getBrowserLogin"),
    getStoreLogin: method("getStoreLogin"),
    setStoreLogin: method("setStoreLogin"),
    isInIncognitoMode: method("isInIncognitoMode"),
    getIsLauncherEnabled: method("getIsLauncherEnabled"),
    enableAppLauncher: method("enableAppLauncher"),
    isPendingCustodianApproval: method("isPendingCustodianApproval"),
    shouldShowEnterprisePromotionBanner: method(
      "shouldShowEnterprisePromotionBanner",
    ),
    getReferrerChain: method("getReferrerChain"),
    getWebGLStatus: method("getWebGLStatus"),
    Result: enumOf({
      SUCCESS: "success",
      USER_CANCELLED: "user_cancelled",
      INVALID_ID: "invalid_id",
      MANIFEST_ERROR: "manifest_error",
      ICON_ERROR: "icon_error",
      INVALID_ICON_URL: "invalid_icon_url",
      ALREADY_INSTALLED: "already_installed",
      BLOCKED_BY_POLICY: "blocked_by_policy",
      BLACKLISTED: "blacklisted",
      MISSING_DEPENDENCIES: "missing_dependencies",
      UNSUPPORTED_EXTENSION_TYPE: "unsupported_extension_type",
      USER_GESTURE_REQUIRED: "user_gesture_required",
      LAUNCH_IN_PROGRESS: "launch_in_progress",
      INSTALL_ERROR: "install_error",
      INSTALL_IN_PROGRESS: "install_in_progress",
      FEATURE_DISABLED: "feature_disabled",
      UNKNOWN_ERROR: "unknown_error",
      BLOCKED_FOR_CHILD_ACCOUNT: "blocked_for_child_account",
    }),
    ExtensionInstallStatus: enumOf({
      INSTALLABLE: "installable",
      ENABLED: "enabled",
      DISABLED: "disabled",
      TERMINATED: "terminated",
      BLOCKED_BY_POLICY: "blocked_by_policy",
      CAN_REQUEST: "can_request",
      REQUEST_PENDING: "request_pending",
      CUSTODIAN_APPROVAL_REQUIRED: "custodian_approval_required",
      FORCE_INSTALLED: "force_installed",
      DEPRECATED_MANIFEST_VERSION: "deprecated_manifest_version",
      CORRUPTED: "corrupted",
    }),
    MV2DeprecationStatus: enumOf({
      INACTIVE: "inactive",
      WARNING: "warning",
      SOFT_DISABLE: "soft_disable",
      HARD_DISABLE: "hard_disable",
    }),
    WebGlStatus: enumOf({
      WEBGL_ALLOWED: "webgl_allowed",
      WEBGL_BLOCKED: "webgl_blocked",
    }),
  };
  const management = (chrome.management ?? {}) as Bag;
  Object.assign(management, {
    getAll: method("management.getAll"),
    get: method("management.get"),
    setEnabled: method("management.setEnabled"),
    uninstall: method("management.uninstall"),
    onInstalled: event("management.onInstalled"),
    onUninstalled: event("management.onUninstalled"),
    onEnabled: event("management.onEnabled"),
    onDisabled: event("management.onDisabled"),
  });
  chrome.management = management;
}
