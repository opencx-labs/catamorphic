/**
 * Chrome's `window.chrome` for a web page: `loadTimes`, `csi` and `app`, as
 * Chrome shapes them (their order, values, argument errors, which of them
 * construct). Electron leaves `window.chrome` empty, and Google's sign-in
 * turns away a browser that says it is Chrome without `chrome.app`:
 * "Couldn't sign you in. This browser or app may not be secure" (ADR 0150).
 * Serialized into the page's main world by `executeInMainWorld`, so it may
 * not close over anything outside its body. A member the page already has
 * stays the page's.
 */
export function installChromeObject(): void {
  // biome-ignore lint/suspicious/noRedundantUseStrict: the main world runs this as a script, where functions are sloppy and own `arguments` and `caller`; Chrome's own functions have neither.
  "use strict";
  const scope: { chrome?: unknown; performance: Performance } = globalThis;
  const existing = scope.chrome;
  const chrome =
    typeof existing === "object" && existing !== null ? existing : {};
  if (chrome !== existing) scope.chrome = chrome;

  /** What Chrome's own bindings throw for arguments they don't take. */
  const invalid = (method: string, signature = "") =>
    new TypeError(`Error in invocation of app.${method}(${signature}): `);
  // Method shorthand: named, no prototype, not constructible, like Chrome's.
  const app = {
    isInstalled: false,
    getDetails(...args: unknown[]): null {
      if (args.length > 0) throw invalid("getDetails");
      return null;
    },
    getIsInstalled(...args: unknown[]): boolean {
      if (args.length > 0) throw invalid("getIsInstalled");
      return false;
    },
    installState(...args: unknown[]): void {
      const [callback] = args;
      if (
        args.length > 1 ||
        (callback !== undefined && typeof callback !== "function")
      )
        throw invalid("installState", "optional function callback");
      // Chrome answers after a round trip to the browser, never in the call.
      if (typeof callback === "function")
        setTimeout(() => callback("not_installed"), 0);
    },
    runningState(...args: unknown[]): string {
      if (args.length > 0) throw invalid("runningState");
      return "cannot_run";
    },
    InstallState: {
      DISABLED: "disabled",
      INSTALLED: "installed",
      NOT_INSTALLED: "not_installed",
    },
    RunningState: {
      CANNOT_RUN: "cannot_run",
      READY_TO_RUN: "ready_to_run",
      RUNNING: "running",
    },
  };

  /** The navigation's milestones, in whole epoch milliseconds (0: not yet). */
  const timing = () => {
    const performance = scope.performance;
    const origin = performance.timeOrigin;
    const [entry] = performance.getEntriesByType("navigation");
    const navigation =
      typeof PerformanceNavigationTiming === "function" &&
      entry instanceof PerformanceNavigationTiming
        ? entry
        : undefined;
    const at = (offset = 0) => (offset > 0 ? Math.floor(origin + offset) : 0);
    return {
      start: Math.floor(origin),
      commit: at(navigation?.responseStart),
      domReady: at(navigation?.domContentLoadedEventEnd),
      loaded: at(navigation?.loadEventEnd),
      firstPaint: at(performance.getEntriesByName("first-paint")[0]?.startTime),
      type: navigation?.type ?? "navigate",
      protocol: navigation?.nextHopProtocol ?? "",
      pageMs: Math.round(performance.now() * 1000) / 1000,
    };
  };
  const navigationType = (type: string) =>
    type === "reload"
      ? "Reload"
      : type === "back_forward"
        ? "BackForward"
        : "Other";
  const transition = (type: string) =>
    type === "reload" ? 16 : type === "back_forward" ? 6 : 15;

  // Declarations, not arrows: Chrome's loadTimes and csi construct and
  // have a prototype. Chrome's are anonymous, so their names go.
  function loadTimes() {
    const now = timing();
    const negotiated = location.protocol === "https:" && now.protocol !== "";
    return {
      requestTime: now.start / 1000,
      startLoadTime: now.start / 1000,
      commitLoadTime: now.commit / 1000,
      finishDocumentLoadTime: now.domReady / 1000,
      finishLoadTime: now.loaded / 1000,
      firstPaintTime: now.firstPaint / 1000,
      firstPaintAfterLoadTime: 0,
      navigationType: navigationType(now.type),
      wasFetchedViaSpdy: now.protocol === "h2" || now.protocol === "h3",
      wasNpnNegotiated: negotiated,
      npnNegotiatedProtocol: negotiated ? now.protocol : "unknown",
      wasAlternateProtocolAvailable: false,
      connectionInfo: now.protocol || "unknown",
    };
  }
  function csi() {
    const now = timing();
    return {
      startE: now.start,
      onloadT: now.domReady,
      pageT: now.pageMs,
      tran: transition(now.type),
    };
  }
  for (const fn of [loadTimes, csi])
    Object.defineProperty(fn, "name", { value: "" });

  for (const [name, value] of [
    ["loadTimes", loadTimes],
    ["csi", csi],
    ["app", app],
  ] as const) {
    if (!(name in chrome)) Reflect.set(chrome, name, value);
  }
}
