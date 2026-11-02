import { useEffect, useRef, useState } from "react";
import type { McpAppContext } from "../../shared/chat.js";
import { desktopApi, type McpAppViewData } from "../lib/desktop-api.js";

/**
 * Renders an MCP Apps view (extension io.modelcontextprotocol/ui): the
 * tool's `ui://` template in a hard-sandboxed iframe, bridged over
 * postMessage JSON-RPC. The host side implements the dialect's core:
 * `ui/initialize`, `tools/call` (routed to the SAME server the view came
 * from, over the desktop's own connection), `ui/open-link`, and the
 * tool-input/tool-result notifications that seed the view with the chat's
 * originating call.
 *
 * Isolation matches our own AppMount: `sandbox="allow-scripts
 * allow-forms"`, opaque origin, and a CSP built from the resource's
 * declared `_meta.ui.csp` domains — absent lists mean default-deny.
 */

const MAX_VIEW_CALLS_IN_FLIGHT = 8;

export function McpAppScreen({
  toolKey,
  context,
  toolUseId,
  toolInput,
  toolResult,
  onOpenLink,
}: {
  toolKey: string;
  context?: McpAppContext;
  toolUseId: string;
  toolInput?: unknown;
  toolResult?: unknown;
  onOpenLink?: (url: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<McpAppViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentMount = useRef<string | null>(null);
  const frameLoaded = useRef(false);
  const projectId = context?.projectId;
  const sessionId = context?.sessionId;

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    frameLoaded.current = false;
    let mountId: string | undefined;
    if (!projectId || !sessionId) {
      setError("Reopen this app from its original chat.");
      return;
    }
    desktopApi
      .mcpAppsView({ projectId, sessionId, toolKey, toolUseId })
      .then((data) => {
        mountId = data.mountId;
        if (cancelled) {
          void desktopApi.mcpAppsClose(data.mountId).catch(() => {});
          return;
        }
        currentMount.current = data.mountId;
        setView(data);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
      if (currentMount.current === mountId) currentMount.current = null;
      if (mountId) void desktopApi.mcpAppsClose(mountId).catch(() => {});
    };
  }, [toolKey, toolUseId, projectId, sessionId]);

  // Latest call payload without re-subscribing the message listener.
  const seedRef = useRef({ toolInput, toolResult });
  seedRef.current = { toolInput, toolResult };
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;

  useEffect(() => {
    if (!view) return;
    let initialized = false;
    let ready = false;
    let active = true;
    let inFlight = 0;
    let pinnedOrigin: object | undefined;
    let replyPort: MessagePort | undefined;
    const post = (data: unknown) =>
      replyPort?.postMessage({ data, origin: window.origin });
    const alive = () => active && currentMount.current === view.mountId;
    const listener = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!alive() || !frame || event.source !== frame.contentWindow) return;
      const data = event.data as {
        jsonrpc?: string;
        id?: number | string;
        method?: string;
        params?: Record<string, unknown>;
      } | null;
      if (data?.jsonrpc !== "2.0" || typeof data.method !== "string") {
        return;
      }
      if (data.method === "work/view-ready") {
        if (
          !ready &&
          data.params?.token === view.documentToken &&
          event.ports[0]
        ) {
          ready = true;
          replyPort = event.ports[0];
          pinnedOrigin = messageOrigin(event);
        }
        return;
      }
      if (!ready || !sameMessageOrigin(event, pinnedOrigin)) return;
      const respond = (result: unknown) => {
        if (alive() && data.id !== undefined) {
          post({ jsonrpc: "2.0", id: data.id, result });
        }
      };
      const respondError = (code: number, message: string) => {
        if (alive() && data.id !== undefined) {
          post({ jsonrpc: "2.0", id: data.id, error: { code, message } });
        }
      };

      switch (data.method) {
        case "ui/initialize": {
          respond({ hostContext: { theme: "dark" } });
          // Seed the view with the originating call once it's listening.
          if (!initialized) {
            initialized = true;
            const { toolInput: input, toolResult: result } = seedRef.current;
            const notify = (method: string, params: unknown) =>
              post({ jsonrpc: "2.0", method, params });
            if (input !== undefined) {
              notify("ui/notifications/tool-input", { arguments: input });
            }
            if (result !== undefined) {
              notify("ui/notifications/tool-result", { result });
            }
          }
          return;
        }
        case "tools/call": {
          const name =
            typeof data.params?.name === "string" ? data.params.name : "";
          const args =
            typeof data.params?.arguments === "object" &&
            data.params.arguments !== null
              ? (data.params.arguments as Record<string, unknown>)
              : {};
          if (inFlight >= MAX_VIEW_CALLS_IN_FLIGHT) {
            respondError(-32000, "Too many concurrent calls");
            return;
          }
          inFlight += 1;
          desktopApi
            .mcpAppsCall(view.mountId, name, args)
            .then(respond)
            .catch((cause) =>
              respondError(
                -32603,
                cause instanceof Error ? cause.message : String(cause),
              ),
            )
            .finally(() => {
              inFlight -= 1;
            });
          return;
        }
        case "ui/open-link": {
          const url =
            typeof data.params?.url === "string" ? data.params.url : "";
          if (/^https?:\/\//.test(url)) onOpenLinkRef.current?.(url);
          respond({});
          return;
        }
        default:
          if (data.method.startsWith("notifications/")) return;
          if (data.method.startsWith("ui/notifications/")) return;
          respondError(-32601, `Method not supported: ${data.method}`);
      }
    };
    window.addEventListener("message", listener);
    return () => {
      active = false;
      replyPort?.close();
      window.removeEventListener("message", listener);
    };
  }, [view]);

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-bg-inset p-6 text-sm text-fg-muted">
        This app view could not load: {error}
      </div>
    );
  }
  if (!view) {
    return (
      <div className="grid h-full place-items-center bg-bg-inset text-sm text-fg-muted">
        Loading app view…
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-hidden bg-bg-inset p-4">
      <iframe
        key={view.mountId}
        ref={frameRef}
        onLoad={() => {
          if (!frameLoaded.current) {
            frameLoaded.current = true;
            return;
          }
          currentMount.current = null;
          void desktopApi.mcpAppsClose(view.mountId).catch(() => {});
          setError("This app navigated away. Reopen it from its chat.");
        }}
        title={`mcp-app-${toolKey}`}
        sandbox="allow-scripts allow-forms"
        // The document-only guest origin applies the resource's own CSP.
        // srcdoc would inherit the shell policy and block inline scripts.
        src={view.url}
        className={`h-full w-full rounded-lg bg-white ${
          view.prefersBorder ? "border border-border" : ""
        }`}
      />
    </div>
  );
}

/** Opaque origins differ between documents even when their text is "null". */
function messageOrigin(event: MessageEvent): object | undefined {
  const api: unknown = Reflect.get(globalThis, "Origin");
  if (typeof api !== "function") return undefined;
  const from: unknown = Reflect.get(api, "from");
  if (typeof from !== "function") return undefined;
  try {
    const origin: unknown = Reflect.apply(from, api, [event]);
    return typeof origin === "object" && origin !== null ? origin : undefined;
  } catch {
    return undefined;
  }
}

function sameMessageOrigin(
  event: MessageEvent,
  pinned: object | undefined,
): boolean {
  const current = messageOrigin(event);
  if (!current || !pinned) return false;
  const same: unknown = Reflect.get(current, "isSameOrigin");
  return (
    typeof same === "function" &&
    Reflect.apply(same, current, [pinned]) === true
  );
}
