/**
 * Chrome's `window.chrome` for a web page: `loadTimes`, `csi` and `app`, as
 * Chrome shapes them (their order, values, argument errors, which of them
 * construct, and that they read as native code). Electron leaves
 * `window.chrome` empty, and Google's sign-in turns away a browser that
 * says it is Chrome without `chrome.app`: "Couldn't sign you in. This
 * browser or app may not be secure" (ADR 0235). Serialized into the page's
 * main world by `executeInMainWorld`, so it may not close over anything
 * outside its body. It runs before the page's own scripts and keeps the
 * globals it calls (performance, timers, Math) from then, so a page that
 * replaces them later does not break it. A member already there stays.
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
  const floor = Math.floor;
  const round = Math.round;
  const finite = Number.isFinite;
  const captureStack = Error.captureStackTrace;
  const protocolOf = () => location.protocol;

  /**
   * What Chrome's own bindings throw for arguments they don't take. A
   * binding leaves no frame of its own in the stack, so neither does this.
   */
  const invalid = (
    method: string,
    signature: string,
    from: (...args: unknown[]) => unknown,
  ) => {
    const error = new TypeError(
      `Error in invocation of app.${method}(${signature}): `,
    );
    captureStack?.(error, from);
    return error;
  };
  // Method shorthand: named, no prototype, not constructible, like Chrome's.
  const methods = {
    getDetails(...args: unknown[]): null {
      if (args.length > 0) throw invalid("getDetails", "", methods.getDetails);
      return null;
    },
    getIsInstalled(...args: unknown[]): boolean {
      if (args.length > 0)
        throw invalid("getIsInstalled", "", methods.getIsInstalled);
      return false;
    },
    installState(...args: unknown[]): void {
      const callback = args[0];
      // An optional callback: Chrome takes null and undefined for none.
      if (
        args.length > 1 ||
        (callback !== undefined &&
          callback !== null &&
          typeof callback !== "function")
      )
        throw invalid(
          "installState",
          "optional function callback",
          methods.installState,
        );
      // Chrome answers after a round trip to the browser, never in the call.
      if (typeof callback === "function")
        later(() => callback("not_installed"), 0);
    },
    runningState(...args: unknown[]): string {
      if (args.length > 0)
        throw invalid("runningState", "", methods.runningState);
      return "cannot_run";
    },
  };
  /**
   * Chrome's app methods are its own bindings, so they read as native code:
   * a bound function does too (`function () { [native code] }`), without a
   * prototype, and throws on `caller` as Chrome's do. It keeps the name.
   */
  const bound = (method: (...args: unknown[]) => unknown, name: string) => {
    const shown = method.bind(undefined);
    Object.defineProperty(shown, "name", { value: name });
    return shown;
  };
  const app = {
    isInstalled: false,
    getDetails: bound(methods.getDetails, "getDetails"),
    getIsInstalled: bound(methods.getIsInstalled, "getIsInstalled"),
    installState: bound(methods.installState, "installState"),
    runningState: bound(methods.runningState, "runningState"),
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
  const start = finite(timeOrigin) ? floor(timeOrigin) : 0;
  const timing = () => {
    const at = (ms: number) => (ms > 0 ? floor(timeOrigin + ms) : 0);
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
        pageMs: round(now() * 1000) / 1000,
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
    const pageProtocol = protocolOf();
    const fromNetwork = pageProtocol === "https:" || pageProtocol === "http:";
    const negotiated = pageProtocol === "https:" && times.protocol !== "";
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
   * loadTimes and csi construct, have a prototype, and answer null for
   * `caller` and `arguments`, which no bound or strict function does. A
   * Proxy keeps all three and reads as Chrome's exact
   * `function () { [native code] }`.
   */
  const native = <T extends object>(target: T): T =>
    new Proxy(target, {
      get: (fn, key, receiver) =>
        key === "caller" || key === "arguments"
          ? null
          : Reflect.get(fn, key, receiver),
    });
  const shownLoadTimes = native(loadTimes);
  const shownCsi = native(csi);
  // `csi.prototype.constructor` names the function the page holds.
  Object.defineProperty(loadTimes.prototype, "constructor", {
    value: shownLoadTimes,
  });
  Object.defineProperty(csi.prototype, "constructor", { value: shownCsi });

  for (const [name, value] of [
    ["loadTimes", shownLoadTimes],
    ["csi", shownCsi],
    ["app", app],
  ] as const) {
    if (!(name in chrome)) Reflect.set(chrome, name, value);
  }
}
