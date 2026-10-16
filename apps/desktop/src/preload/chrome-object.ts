/**
 * Chrome's `window.chrome` for a web page: `loadTimes`, `csi` and `app`, as
 * Chrome shapes them (their order, values, argument errors, which of them
 * construct, and that they read as native code). Electron leaves
 * `window.chrome` empty, and Google's sign-in turns away a browser that
 * says it is Chrome without `chrome.app`: "Couldn't sign you in. This
 * browser or app may not be secure" (ADR 0235). Serialized into the page's
 * main world by `executeInMainWorld`, so it may not close over anything
 * outside its body. It runs before the page's own scripts: it keeps what it
 * needs of the page's globals then, so a page that replaces them later
 * neither breaks it nor sees it call them. A member already there stays.
 */
export function installChromeObject(): void {
  // biome-ignore lint/suspicious/noRedundantUseStrict: the main world runs this as a script, where functions are sloppy and own `arguments` and `caller`; Chrome's own functions have neither.
  "use strict";
  const scope: { chrome?: unknown; performance: Performance } = globalThis;
  const existing = scope.chrome;
  const chrome =
    typeof existing === "object" && existing !== null ? existing : {};
  if (chrome !== existing) scope.chrome = chrome;

  const performance = scope.performance;
  const timeOrigin = performance.timeOrigin;
  const entriesByType = performance.getEntriesByType.bind(performance);
  const entriesByName = performance.getEntriesByName.bind(performance);
  const now = performance.now.bind(performance);
  const later = setTimeout;
  const protocolOf = () => location.protocol;

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
      // An optional callback: Chrome takes null and undefined for none.
      if (
        args.length > 1 ||
        (callback !== undefined &&
          callback !== null &&
          typeof callback !== "function")
      )
        throw invalid("installState", "optional function callback");
      // Chrome answers after a round trip to the browser, never in the call.
      if (typeof callback === "function")
        later(() => callback("not_installed"), 0);
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

  const field = (entry: object | undefined, key: string): unknown =>
    entry && key in entry ? Reflect.get(entry, key) : undefined;
  const offset = (entry: object | undefined, key: string): number => {
    const value = field(entry, key);
    return typeof value === "number" ? value : 0;
  };
  /**
   * The navigation's milestones, in whole epoch milliseconds (0: not yet),
   * and never a throw: Chrome's answer comes from the browser, not the page.
   */
  const timing = () => {
    const start = Number.isFinite(timeOrigin) ? Math.floor(timeOrigin) : 0;
    const at = (ms: number) => (ms > 0 ? Math.floor(timeOrigin + ms) : 0);
    try {
      const navigation: object | undefined = entriesByType("navigation")[0];
      const paint: object | undefined = entriesByName("first-paint")[0];
      const type = field(navigation, "type");
      const protocol = field(navigation, "nextHopProtocol");
      return {
        start,
        commit: at(offset(navigation, "responseStart")),
        domReady: at(offset(navigation, "domContentLoadedEventEnd")),
        loaded: at(offset(navigation, "loadEventEnd")),
        firstPaint: at(offset(paint, "startTime")),
        type: typeof type === "string" ? type : "navigate",
        protocol: typeof protocol === "string" ? protocol : "",
        pageMs: Math.round(now() * 1000) / 1000,
      };
    } catch {
      return {
        start,
        commit: 0,
        domReady: 0,
        loaded: 0,
        firstPaint: 0,
        type: "navigate",
        protocol: "",
        pageMs: 0,
      };
    }
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
    const times = timing();
    const fromNetwork = /^https?:$/.test(protocolOf());
    const negotiated = protocolOf() === "https:" && times.protocol !== "";
    return {
      requestTime: times.start / 1000,
      startLoadTime: times.start / 1000,
      commitLoadTime: times.commit / 1000,
      finishDocumentLoadTime: times.domReady / 1000,
      finishLoadTime: times.loaded / 1000,
      firstPaintTime: times.firstPaint / 1000,
      firstPaintAfterLoadTime: 0,
      navigationType: navigationType(times.type),
      wasFetchedViaSpdy: times.protocol === "h2" || times.protocol === "h3",
      wasNpnNegotiated: negotiated,
      // Chrome says "unknown" for a plain http page, nothing off the network.
      npnNegotiatedProtocol: negotiated
        ? times.protocol
        : fromNetwork
          ? "unknown"
          : "",
      wasAlternateProtocolAvailable: false,
      connectionInfo: times.protocol || "unknown",
    };
  }
  function csi() {
    const times = timing();
    return {
      startE: times.start,
      onloadT: times.domReady,
      pageT: times.pageMs,
      tran: transition(times.type),
    };
  }
  for (const fn of [loadTimes, csi])
    Object.defineProperty(fn, "name", { value: "" });

  /**
   * Chrome's functions are its own bindings, so they read as native code.
   * A function behind a Proxy does too: `function () { [native code] }`,
   * Chrome's exact text for loadTimes and csi. Strict functions throw on
   * `caller` and `arguments`, as Chrome's app methods do; loadTimes and csi
   * answer null, so those two say so.
   */
  const native = <T extends object>(target: T, quietCaller: boolean): T =>
    new Proxy(
      target,
      quietCaller
        ? {
            get: (fn, key, receiver) =>
              key === "caller" || key === "arguments"
                ? null
                : Reflect.get(fn, key, receiver),
          }
        : {},
    );
  const shownLoadTimes = native(loadTimes, true);
  const shownCsi = native(csi, true);
  // `csi.prototype.constructor` names the function the page holds.
  Object.defineProperty(loadTimes.prototype, "constructor", {
    value: shownLoadTimes,
  });
  Object.defineProperty(csi.prototype, "constructor", { value: shownCsi });
  app.getDetails = native(app.getDetails, false);
  app.getIsInstalled = native(app.getIsInstalled, false);
  app.installState = native(app.installState, false);
  app.runningState = native(app.runningState, false);

  for (const [name, value] of [
    ["loadTimes", shownLoadTimes],
    ["csi", shownCsi],
    ["app", app],
  ] as const) {
    if (!(name in chrome)) Reflect.set(chrome, name, value);
  }
}
