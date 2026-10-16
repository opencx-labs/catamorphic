import { describe, expect, it } from "vitest";
import { installChromeObject } from "./chrome-object.js";

/**
 * Expected values are Chrome 154's, read on https://example.com and
 * http://neverssl.com with a fresh profile.
 */
class FakeNavigationTiming {
  responseStart = 0;
  domContentLoadedEventEnd = 0;
  loadEventEnd = 0;
  type = "navigate";
  nextHopProtocol = "";
  constructor(init: Partial<FakeNavigationTiming>) {
    Object.assign(this, init);
  }
}

/**
 * Run the function the way `executeInMainWorld` does: from its source, as a
 * script of its own, so a reference outside its body fails here as it would
 * in a page. The page's globals are parameters, standing in for its window.
 */
function installInPage(
  input: {
    window?: Record<string, unknown>;
    protocol?: string;
    navigation?: Partial<FakeNavigationTiming>;
    firstPaint?: number;
    now?: number;
    /** The browser's own timing call fails. */
    broken?: boolean;
  } = {},
) {
  const window = input.window ?? {};
  window.performance = {
    timeOrigin: 1792167008130.6,
    now: () => input.now ?? 3070.7311,
    getEntriesByType: (type: string) => {
      if (input.broken) throw new Error("no timing");
      return type === "navigation" && input.navigation
        ? [new FakeNavigationTiming(input.navigation)]
        : [];
    },
    getEntriesByName: (name: string) =>
      name === "first-paint" && input.firstPaint !== undefined
        ? [{ startTime: input.firstPaint }]
        : [],
  };
  const run = new Function(
    "globalThis",
    "location",
    `(${installChromeObject.toString()})();`,
  );
  run(window, { protocol: input.protocol ?? "https:" });
  return window;
}

interface PageChrome {
  loadTimes: () => Record<string, unknown>;
  csi: () => Record<string, unknown>;
  app: Record<string, unknown> & {
    getDetails: (...args: unknown[]) => unknown;
    getIsInstalled: (...args: unknown[]) => unknown;
    installState: (...args: unknown[]) => unknown;
    runningState: (...args: unknown[]) => unknown;
  };
}
const chromeOf = (window: Record<string, unknown>): PageChrome =>
  window.chrome as PageChrome;

describe("installChromeObject", () => {
  it("gives a page Chrome's members, in Chrome's order", () => {
    const chrome = chromeOf(installInPage());
    expect(Object.keys(chrome)).toEqual(["loadTimes", "csi", "app"]);
    expect(Object.keys(chrome.app)).toEqual([
      "isInstalled",
      "getDetails",
      "getIsInstalled",
      "installState",
      "runningState",
      "InstallState",
      "RunningState",
    ]);
    expect(JSON.stringify(chrome.app)).toBe(
      '{"isInstalled":false,"InstallState":{"DISABLED":"disabled","INSTALLED":"installed","NOT_INSTALLED":"not_installed"},"RunningState":{"CANNOT_RUN":"cannot_run","READY_TO_RUN":"ready_to_run","RUNNING":"running"}}',
    );
    expect(chrome.app.getDetails()).toBeNull();
    expect(chrome.app.getIsInstalled()).toBe(false);
    expect(chrome.app.runningState()).toBe("cannot_run");
    expect(chrome.app.installState()).toBeUndefined();
  });

  it("refuses arguments the way Chrome's bindings do", () => {
    const { app } = chromeOf(installInPage());
    const refusal = (method: string, signature = "") =>
      new TypeError(`Error in invocation of app.${method}(${signature}): `);
    expect(() => app.getDetails(undefined)).toThrow(refusal("getDetails"));
    expect(() => app.getIsInstalled(1)).toThrow(refusal("getIsInstalled"));
    expect(() => app.runningState(1)).toThrow(refusal("runningState"));
    const installState = refusal("installState", "optional function callback");
    expect(() => app.installState("x")).toThrow(installState);
    expect(() => app.installState(() => {}, 1)).toThrow(installState);
    // Chrome doesn't check `this`.
    expect(app.getDetails.call({})).toBeNull();
  });

  it("leaves no frame of its own in a refusal's stack", () => {
    const { app } = chromeOf(installInPage());
    const stack = (() => {
      try {
        app.installState("x");
      } catch (error) {
        return error instanceof Error ? (error.stack ?? "") : "";
      }
      return "";
    })();
    const frames = stack.split("\n").slice(1).join("\n");
    expect(frames).not.toMatch(/invalid|installState|getDetails/);
  });

  it("takes null for installState's callback, as Chrome does", () => {
    const { app } = chromeOf(installInPage());
    expect(app.installState(null)).toBeUndefined();
    expect(app.installState(undefined)).toBeUndefined();
  });

  it("answers installState after the call, never in it", async () => {
    const { app } = chromeOf(installInPage());
    const answers: unknown[] = [];
    app.installState((state: unknown) => answers.push(state));
    expect(answers).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(answers).toEqual(["not_installed"]);
  });

  it("reads as native code, as Chrome's bindings do", () => {
    const chrome = chromeOf(installInPage());
    const source = (fn: unknown) => Function.prototype.toString.call(fn);
    // Chrome's exact text for these two.
    expect(source(chrome.loadTimes)).toBe("function () { [native code] }");
    expect(source(chrome.csi)).toBe("function () { [native code] }");
    expect(source(chrome.app.getDetails)).toContain("[native code]");
    // Chrome's loadTimes and csi answer null; its app methods throw.
    expect(Reflect.get(chrome.csi, "caller")).toBeNull();
    expect(Reflect.get(chrome.loadTimes, "arguments")).toBeNull();
    expect(() => Reflect.get(chrome.app.getDetails, "caller")).toThrow(
      TypeError,
    );
    // The prototype names the function the page holds.
    expect(Reflect.get(chrome.csi, "prototype").constructor).toBe(chrome.csi);
  });

  it("shapes each function as Chrome does", () => {
    const chrome = chromeOf(installInPage());
    for (const name of [
      "getDetails",
      "getIsInstalled",
      "installState",
      "runningState",
    ]) {
      const method = chrome.app[name];
      if (typeof method !== "function") throw new Error(`${name} missing`);
      expect(method.name).toBe(name);
      expect(method.length).toBe(0);
      expect(Object.getOwnPropertyNames(method)).toEqual(["length", "name"]);
      expect(() => Reflect.construct(method, [])).toThrow(TypeError);
    }
    for (const fn of [chrome.loadTimes, chrome.csi]) {
      expect(fn.name).toBe("");
      expect(fn.length).toBe(0);
      // Strict, though the page runs it as a script: no own `arguments`.
      expect(Object.getOwnPropertyNames(fn).sort()).toEqual([
        "length",
        "name",
        "prototype",
      ]);
      expect(Object.keys(Reflect.construct(fn, []))).toEqual(Object.keys(fn()));
    }
  });

  it("reports the navigation's timing as Chrome does", () => {
    const chrome = chromeOf(
      installInPage({
        navigation: {
          responseStart: 42.6,
          domContentLoadedEventEnd: 102.1,
          loadEventEnd: 102.7,
          nextHopProtocol: "h3",
        },
        firstPaint: 115.4,
      }),
    );
    expect(chrome.loadTimes()).toEqual({
      requestTime: 1792167008.13,
      startLoadTime: 1792167008.13,
      commitLoadTime: 1792167008.173,
      finishDocumentLoadTime: 1792167008.232,
      finishLoadTime: 1792167008.233,
      firstPaintTime: 1792167008.246,
      firstPaintAfterLoadTime: 0,
      navigationType: "Other",
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true,
      npnNegotiatedProtocol: "h3",
      wasAlternateProtocolAvailable: false,
      connectionInfo: "h3",
    });
    // Chrome's key order, too.
    expect(Object.keys(chrome.loadTimes())[0]).toBe("requestTime");
    expect(chrome.csi()).toEqual({
      startE: 1792167008130,
      onloadT: 1792167008232,
      pageT: 3070.731,
      tran: 15,
    });
  });

  it("reports an insecure page, a reload and a page still loading", () => {
    const plain = chromeOf(
      installInPage({
        protocol: "http:",
        navigation: { responseStart: 40, nextHopProtocol: "http/1.1" },
      }),
    ).loadTimes();
    expect(plain).toMatchObject({
      finishDocumentLoadTime: 0,
      finishLoadTime: 0,
      firstPaintTime: 0,
      wasFetchedViaSpdy: false,
      wasNpnNegotiated: false,
      npnNegotiatedProtocol: "unknown",
      connectionInfo: "http/1.1",
    });
    const reload = chromeOf(installInPage({ navigation: { type: "reload" } }));
    expect(reload.loadTimes().navigationType).toBe("Reload");
    expect(reload.csi().tran).toBe(16);
    const back = chromeOf(
      installInPage({ navigation: { type: "back_forward" } }),
    );
    expect(back.loadTimes().navigationType).toBe("BackForward");
    expect(back.csi().tran).toBe(6);
    // Before the navigation entry exists, Chrome's times are zero too.
    expect(chromeOf(installInPage()).csi().onloadT).toBe(0);
  });

  it("keeps answering when the page replaces its timing, or timing fails", () => {
    const window = installInPage({
      navigation: { domContentLoadedEventEnd: 102.1 },
    });
    // A page's script runs after the preload and may swap performance out.
    window.performance = { now: () => 1 };
    expect(chromeOf(window).csi()).toMatchObject({
      startE: 1792167008130,
      onloadT: 1792167008232,
    });
    const broken = chromeOf(installInPage({ broken: true }));
    expect(broken.csi()).toEqual({
      startE: 1792167008130,
      onloadT: 0,
      pageT: 0,
      tran: 15,
    });
    expect(broken.loadTimes().finishLoadTime).toBe(0);
  });

  it("names no protocol for a page off the network", () => {
    for (const protocol of ["about:", "data:", "file:"]) {
      const times = chromeOf(installInPage({ protocol })).loadTimes();
      expect(times.npnNegotiatedProtocol).toBe("");
    }
  });

  it("leaves members already there, and creates window.chrome", () => {
    const own = { mine: true };
    const window = installInPage({ window: { chrome: { app: own } } });
    const chrome = chromeOf(window);
    expect(chrome.app).toBe(own);
    expect(Object.keys(chrome)).toEqual(["app", "loadTimes", "csi"]);
    expect(Object.keys(chromeOf(installInPage({ window: {} })))).toEqual([
      "loadTimes",
      "csi",
      "app",
    ]);
  });
});
