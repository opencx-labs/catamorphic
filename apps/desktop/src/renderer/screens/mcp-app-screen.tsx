import { useEffect, useRef, useState } from "react";
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
  toolInput,
  toolResult,
  onOpenLink,
}: {
  toolKey: string;
  toolInput?: unknown;
  toolResult?: unknown;
  onOpenLink?: (url: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<McpAppViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(0);
  const initializedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    desktopApi
      .mcpAppsView(toolKey)
      .then((data) => {
        if (!cancelled) setView(data);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [toolKey]);

  // Latest call payload without re-subscribing the message listener.
  const seedRef = useRef({ toolInput, toolResult });
  seedRef.current = { toolInput, toolResult };
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;

  useEffect(() => {
    if (!view) return;
    initializedRef.current = false;
    const listener = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as {
        jsonrpc?: string;
        id?: number | string;
        method?: string;
        params?: Record<string, unknown>;
      } | null;
      if (data?.jsonrpc !== "2.0" || typeof data.method !== "string") {
        return;
      }
      const respond = (result: unknown) => {
        if (data.id !== undefined) {
          frame.contentWindow?.postMessage(
            { jsonrpc: "2.0", id: data.id, result },
            "*",
          );
        }
      };
      const respondError = (code: number, message: string) => {
        if (data.id !== undefined) {
          frame.contentWindow?.postMessage(
            { jsonrpc: "2.0", id: data.id, error: { code, message } },
            "*",
          );
        }
      };

      switch (data.method) {
        case "ui/initialize": {
          respond({ hostContext: { theme: "dark" } });
          // Seed the view with the originating call once it's listening.
          if (!initializedRef.current) {
            initializedRef.current = true;
            const { toolInput: input, toolResult: result } = seedRef.current;
            const notify = (method: string, params: unknown) =>
              frame.contentWindow?.postMessage(
                { jsonrpc: "2.0", method, params },
                "*",
              );
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
          if (inFlight.current >= MAX_VIEW_CALLS_IN_FLIGHT) {
            respondError(-32000, "Too many concurrent calls");
            return;
          }
          inFlight.current += 1;
          desktopApi
            .mcpAppsCall(toolKey, name, args)
            .then(respond)
            .catch((cause) =>
              respondError(
                -32603,
                cause instanceof Error ? cause.message : String(cause),
              ),
            )
            .finally(() => {
              inFlight.current -= 1;
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
    return () => window.removeEventListener("message", listener);
  }, [view, toolKey]);

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
        ref={frameRef}
        title={`mcp-app-${toolKey}`}
        sandbox="allow-scripts allow-forms"
        srcDoc={withCsp(view)}
        className={`h-full w-full rounded-lg bg-white ${
          view.prefersBorder ? "border border-border" : ""
        }`}
      />
    </div>
  );
}

/**
 * The iframe CSP, from the resource's declared domain lists. Defaults are
 * the spec's: no network, inline script/style only, data/blob images.
 * Declared domains widen exactly the directives the spec maps them to.
 */
function withCsp(view: McpAppViewData): string {
  const resource = view.csp.resourceDomains.join(" ");
  const connect = view.csp.connectDomains.join(" ");
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${resource ? ` ${resource}` : ""}`,
    `style-src 'unsafe-inline'${resource ? ` ${resource}` : ""}`,
    `img-src data: blob:${resource ? ` ${resource}` : ""}`,
    `font-src data:${resource ? ` ${resource}` : ""}`,
    connect ? `connect-src ${connect}` : "connect-src 'none'",
  ].join("; ");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const html = view.html;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const at = headMatch.index + headMatch[0].length;
    return `${html.slice(0, at)}${meta}${html.slice(at)}`;
  }
  return `${meta}${html}`;
}
