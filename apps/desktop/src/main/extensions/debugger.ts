import { scriptableUrl } from "./url-policy.js";

/**
 * `chrome.debugger` on Work's tabs (ADR 0203). Extensions such as Claude
 * and ChatGPT drive a page through the DevTools protocol. Work gives them
 * the tab's own target only: domains that reach the browser (including
 * browser-wide tracing and memory), other targets, local files, downloads
 * to disk and certificate checks stay closed, and a
 * page may only be sent to web addresses. While attached, the tab shows
 * which extension is controlling it, with a way to stop it.
 */

/** Domains a tab's debugger client may use at all. */
const ALLOWED_DOMAINS = new Set([
  "Accessibility",
  "Animation",
  "Audits",
  "CSS",
  "CacheStorage",
  "Console",
  "DOM",
  "DOMDebugger",
  "DOMSnapshot",
  "DOMStorage",
  "Debugger",
  "Emulation",
  "EventBreakpoints",
  "Fetch",
  "HeapProfiler",
  "IO",
  "IndexedDB",
  "Input",
  "Inspector",
  "LayerTree",
  "Log",
  "Media",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "PerformanceTimeline",
  "Preload",
  "Profiler",
  "Runtime",
  "Schema",
  "Security",
  "Target",
  "WebAudio",
]);

/**
 * Methods within allowed domains that reach beyond the tab: local files
 * (Electron's debugger client may read them), other sites' cookies, the
 * disk and certificate checks.
 */
const BLOCKED_METHODS = new Set([
  "DOM.setFileInputFiles",
  "DOM.getFileInfo",
  "Network.loadNetworkResource",
  "Network.getAllCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Page.setDownloadBehavior",
  "Page.addCompilationCache",
  "Security.setIgnoreCertificateErrors",
  "Security.handleCertificateError",
  "Security.setOverrideCertificateErrors",
]);

/** The Target methods a tab may use: its own frames and workers only. */
const TARGET_METHODS = new Set([
  "Target.setAutoAttach",
  "Target.detachFromTarget",
  "Target.getTargetInfo",
]);

/** Why a command is refused, or null when it may run. */
export function debuggerCommandRefusal(
  method: string,
  params: Record<string, unknown> | undefined,
): string | null {
  const domain = method.split(".")[0] ?? "";
  if (!ALLOWED_DOMAINS.has(domain) || BLOCKED_METHODS.has(method))
    return `${method} is not allowed`;
  if (domain === "Target") {
    if (!TARGET_METHODS.has(method)) return `${method} is not allowed`;
    if (method === "Target.getTargetInfo" && params?.targetId !== undefined)
      return "Target.getTargetInfo only describes this tab";
    // Child targets are reached through their own session ids, which
    // Work checks one by one.
    if (method === "Target.setAutoAttach" && params?.flatten !== true)
      return "Target.setAutoAttach needs flatten: true";
  }
  if (method === "Network.getCookies" && params?.urls !== undefined)
    return "Network.getCookies only reads the page's own cookies";
  if (method === "Input.dispatchDragEvent") {
    const data = params?.data;
    if (
      data !== null &&
      typeof data === "object" &&
      "files" in data &&
      Array.isArray(data.files) &&
      data.files.length > 0
    )
      return "Dragging files into a page is not allowed";
  }
  if (method === "Page.navigate") {
    const url = params?.url;
    if (typeof url !== "string" || !scriptableUrl(url))
      return "The debugger may only navigate to web pages";
  }
  return null;
}

/** The parts of a tab's `WebContents` a debugger session uses. */
export interface DebuggerGuest {
  getURL(): string;
  isDestroyed(): boolean;
  on(
    event: "did-start-navigation",
    listener: (details: { url: string; isMainFrame: boolean }) => void,
  ): unknown;
  off(
    event: "did-start-navigation",
    listener: (details: { url: string; isMainFrame: boolean }) => void,
  ): unknown;
  off(event: "destroyed", listener: () => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion: string): void;
    detach(): void;
    sendCommand(
      method: string,
      params?: object,
      sessionId?: string,
    ): Promise<unknown>;
    on(
      event: "message" | "detach",
      listener: (...args: unknown[]) => void,
    ): unknown;
    off(
      event: "message" | "detach",
      listener: (...args: unknown[]) => void,
    ): unknown;
  };
}

export interface DebuggerTarget {
  guest: DebuggerGuest;
  tabId: number;
}

interface Session {
  guest: DebuggerGuest;
  /** The `${profileId}:${extensionId}` attached to this tab. */
  client: string;
  /** Child targets (out-of-process frames, workers) it may drive, by session id. */
  children: Map<string, string>;
  onMessage: (...args: unknown[]) => void;
  onDetach: (...args: unknown[]) => void;
  onNavigate: (details: { url: string; isMainFrame: boolean }) => void;
  onDestroyed: () => void;
}

export interface DebuggerEvents {
  onEvent: (
    client: string,
    tabId: number,
    method: string,
    params: unknown,
    sessionId: string | undefined,
  ) => void;
  onDetach: (client: string, tabId: number, reason: string) => void;
  onChange: (tabId: number) => void;
}

/**
 * One extension per tab, on a debugger session Work attaches for it alone,
 * as Chrome refuses a second client: what one client sets up (scripts for
 * new documents, request interception) must not outlive it in a session
 * another client keeps. The session ends when the page leaves the web
 * (another extension's page, a local file, the Web Store), and child
 * targets that aren't web pages are detached before the client hears of
 * them.
 */
export class ExtensionDebuggers {
  private readonly sessions = new Map<number, Session>();

  constructor(
    private readonly events: DebuggerEvents,
    /** Whether a page may be debugged at this address. */
    private readonly mayDebug: (url: string) => boolean,
  ) {}

  /** Every extension attached to any tab. */
  allClients(): string[] {
    return [
      ...new Set([...this.sessions.values()].map((session) => session.client)),
    ];
  }

  clients(tabId: number): string[] {
    const session = this.sessions.get(tabId);
    return session ? [session.client] : [];
  }

  isAttached(client: string, tabId: number): boolean {
    return this.sessions.get(tabId)?.client === client;
  }

  attach(client: string, target: DebuggerTarget, version: string): void {
    if (!/^1\.\d+$/.test(version))
      throw new Error(
        `Requested protocol version is not supported: ${version}.`,
      );
    const { guest, tabId } = target;
    if (!this.mayDebug(guest.getURL()))
      throw new Error(`Cannot access contents of url "${guest.getURL()}".`);
    if (this.sessions.has(tabId) || guest.debugger.isAttached())
      throw new Error(
        `Another debugger is already attached to the tab with id: ${tabId}.`,
      );
    try {
      guest.debugger.attach("1.3");
    } catch (cause) {
      throw new Error(
        `Cannot attach to the tab with id: ${tabId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const children = new Map<string, string>();
    const dropChild = (sessionId: string) => {
      children.delete(sessionId);
      void guest.debugger
        .sendCommand("Target.detachFromTarget", { sessionId })
        .catch(() => {});
    };
    const onMessage = (...args: unknown[]) => {
      const [, method, params, rawSessionId] = args;
      if (typeof method !== "string") return;
      const sessionId =
        typeof rawSessionId === "string" && rawSessionId
          ? rawSessionId
          : undefined;
      // Events from a child the client may not drive never reach it.
      if (sessionId !== undefined && !children.has(sessionId)) return;
      const info = targetEvent(params);
      if (method === "Target.attachedToTarget" && info) {
        if (!info.sessionId) return;
        if (!this.mayDebug(info.url)) {
          dropChild(info.sessionId);
          return;
        }
        children.set(info.sessionId, info.targetId);
      } else if (method === "Target.targetInfoChanged" && info) {
        if (!this.mayDebug(info.url))
          for (const [child, targetId] of [...children])
            if (targetId === info.targetId) dropChild(child);
      } else if (method === "Target.detachedFromTarget" && info?.sessionId) {
        if (!children.delete(info.sessionId)) return;
      }
      if (this.sessions.get(tabId)?.guest !== guest) return;
      this.events.onEvent(client, tabId, method, params, sessionId);
    };
    const onDetach = () => this.end(tabId, "target_closed");
    // Leaving the web ends it before the new page commits.
    const onNavigate = (details: { url: string; isMainFrame: boolean }) => {
      if (details.isMainFrame && !this.mayDebug(details.url))
        this.end(tabId, "target_closed");
    };
    guest.debugger.on("message", onMessage);
    guest.debugger.on("detach", onDetach);
    const onDestroyed = () => this.end(tabId, "target_closed");
    guest.on("did-start-navigation", onNavigate);
    guest.once("destroyed", onDestroyed);
    this.sessions.set(tabId, {
      guest,
      client,
      children,
      onMessage,
      onDetach,
      onNavigate,
      onDestroyed,
    });
    this.events.onChange(tabId);
  }

  async sendCommand(
    client: string,
    tabId: number,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
  ): Promise<unknown> {
    const session = this.sessions.get(tabId);
    if (session?.client !== client)
      throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    const refusal = debuggerCommandRefusal(method, params);
    if (refusal) throw new Error(refusal);
    if (session.guest.isDestroyed())
      throw new Error(`No tab with given id ${tabId}.`);
    if (!this.mayDebug(session.guest.getURL())) {
      this.end(tabId, "target_closed");
      throw new Error(
        `Cannot access contents of url "${session.guest.getURL()}".`,
      );
    }
    if (sessionId !== undefined && !session.children.has(sessionId))
      throw new Error(`No session with given id: ${sessionId}.`);
    if (method === "Target.detachFromTarget") {
      const child = params?.sessionId;
      if (typeof child !== "string" || !session.children.has(child))
        throw new Error("Target.detachFromTarget only detaches child sessions");
    }
    return session.guest.debugger.sendCommand(method, params ?? {}, sessionId);
  }

  detach(client: string, tabId: number): void {
    const session = this.sessions.get(tabId);
    if (session?.client !== client)
      throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    this.release(tabId, session);
    this.events.onChange(tabId);
  }

  /** The person stopped it, the page left the web, or the tab went away. */
  end(tabId: number, reason: "canceled_by_user" | "target_closed"): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.release(tabId, session);
    this.events.onDetach(session.client, tabId, reason);
    this.events.onChange(tabId);
  }

  /** An extension unloaded: drop it from every tab. */
  forgetClient(client: string): void {
    for (const [tabId, session] of [...this.sessions]) {
      if (session.client !== client) continue;
      this.release(tabId, session);
      this.events.onChange(tabId);
    }
  }

  private release(tabId: number, session: Session): void {
    this.sessions.delete(tabId);
    const { guest } = session;
    if (guest.isDestroyed()) return;
    guest.off("did-start-navigation", session.onNavigate);
    guest.off("destroyed", session.onDestroyed);
    guest.debugger.off("message", session.onMessage);
    guest.debugger.off("detach", session.onDetach);
    if (guest.debugger.isAttached()) {
      try {
        guest.debugger.detach();
      } catch {
        // Already gone.
      }
    }
  }
}

/** The target an attach, change or detach event names. */
function targetEvent(
  params: unknown,
): { sessionId: string | null; targetId: string; url: string } | null {
  if (params === null || typeof params !== "object") return null;
  const sessionId =
    "sessionId" in params && typeof params.sessionId === "string"
      ? params.sessionId
      : null;
  const info =
    "targetInfo" in params &&
    params.targetInfo !== null &&
    typeof params.targetInfo === "object"
      ? params.targetInfo
      : null;
  const targetId =
    info && "targetId" in info && typeof info.targetId === "string"
      ? info.targetId
      : "";
  const url =
    info && "url" in info && typeof info.url === "string" ? info.url : "";
  return { sessionId, targetId, url };
}
