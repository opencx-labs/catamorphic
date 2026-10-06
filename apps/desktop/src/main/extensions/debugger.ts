import type { WebContents } from "electron";
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

/** Methods within allowed domains that reach beyond the tab. */
const BLOCKED_METHODS = new Set([
  "DOM.setFileInputFiles",
  "Network.getAllCookies",
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
  }
  if (method === "Page.navigate") {
    const url = params?.url;
    if (typeof url !== "string" || !scriptableUrl(url))
      return "The debugger may only navigate to web pages";
  }
  return null;
}

export interface DebuggerTarget {
  guest: WebContents;
  tabId: number;
}

interface Session {
  guest: WebContents;
  /** `${profileId}:${extensionId}` keys attached to this tab. */
  clients: Set<string>;
  /** Work attached Electron's client for these extensions. */
  ownsAttachment: boolean;
  onMessage: (...args: unknown[]) => void;
  onDetach: (...args: unknown[]) => void;
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

export class ExtensionDebuggers {
  private readonly sessions = new Map<number, Session>();

  constructor(private readonly events: DebuggerEvents) {}

  /** Every extension attached to any tab. */
  allClients(): string[] {
    return [
      ...new Set(
        [...this.sessions.values()].flatMap((session) => [...session.clients]),
      ),
    ];
  }

  clients(tabId: number): string[] {
    return [...(this.sessions.get(tabId)?.clients ?? [])];
  }

  isAttached(client: string, tabId: number): boolean {
    return this.sessions.get(tabId)?.clients.has(client) ?? false;
  }

  attach(client: string, target: DebuggerTarget, version: string): void {
    if (!/^1\.\d+$/.test(version))
      throw new Error(
        `Requested protocol version is not supported: ${version}.`,
      );
    const { guest, tabId } = target;
    if (!scriptableUrl(guest.getURL()))
      throw new Error(`Cannot access contents of url "${guest.getURL()}".`);
    const existing = this.sessions.get(tabId);
    if (existing?.clients.has(client))
      throw new Error(
        `Another debugger is already attached to the tab with id: ${tabId}.`,
      );
    if (existing) {
      existing.clients.add(client);
      this.events.onChange(tabId);
      return;
    }
    let ownsAttachment = false;
    if (!guest.debugger.isAttached()) {
      try {
        guest.debugger.attach("1.3");
        ownsAttachment = true;
      } catch (cause) {
        throw new Error(
          `Cannot attach to the tab with id: ${tabId}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    const onMessage = (...args: unknown[]) => {
      const [, method, params, sessionId] = args;
      if (typeof method !== "string") return;
      const session = this.sessions.get(tabId);
      for (const each of session?.clients ?? [])
        this.events.onEvent(
          each,
          tabId,
          method,
          params,
          typeof sessionId === "string" && sessionId ? sessionId : undefined,
        );
    };
    const onDetach = () => this.end(tabId, "target_closed");
    guest.debugger.on("message", onMessage);
    guest.debugger.on("detach", onDetach);
    this.sessions.set(tabId, {
      guest,
      clients: new Set([client]),
      ownsAttachment,
      onMessage,
      onDetach,
    });
    guest.once("destroyed", () => this.end(tabId, "target_closed"));
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
    if (!session?.clients.has(client))
      throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    const refusal = debuggerCommandRefusal(method, params);
    if (refusal) throw new Error(refusal);
    if (session.guest.isDestroyed())
      throw new Error(`No tab with given id ${tabId}.`);
    return session.guest.debugger.sendCommand(method, params ?? {}, sessionId);
  }

  detach(client: string, tabId: number): void {
    const session = this.sessions.get(tabId);
    if (!session?.clients.delete(client))
      throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    if (session.clients.size === 0) this.release(tabId, session);
    this.events.onChange(tabId);
  }

  /** The person stopped it, or the tab went away: every client hears why. */
  end(tabId: number, reason: "canceled_by_user" | "target_closed"): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    const clients = [...session.clients];
    session.clients.clear();
    this.release(tabId, session);
    for (const client of clients) this.events.onDetach(client, tabId, reason);
    this.events.onChange(tabId);
  }

  /** An extension unloaded: drop it from every tab. */
  forgetClient(client: string): void {
    for (const [tabId, session] of [...this.sessions]) {
      if (!session.clients.delete(client)) continue;
      if (session.clients.size === 0) this.release(tabId, session);
      this.events.onChange(tabId);
    }
  }

  private release(tabId: number, session: Session): void {
    this.sessions.delete(tabId);
    const { guest } = session;
    if (guest.isDestroyed()) return;
    guest.debugger.off("message", session.onMessage);
    guest.debugger.off("detach", session.onDetach);
    if (session.ownsAttachment && guest.debugger.isAttached()) {
      try {
        guest.debugger.detach();
      } catch {
        // Already gone.
      }
    }
  }
}
